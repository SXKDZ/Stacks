export interface BedrockMessage {
  role: "user" | "assistant";
  content: string;
}

interface BedrockInvocationOptions {
  token: string;
  region: string;
  model: string;
  system: string;
  messages: BedrockMessage[];
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
}

interface RuntimeResponse {
  output?: {
    message?: {
      content?: Array<{ text?: string }>;
    };
  };
  usage?: Record<string, unknown>;
}

interface MantleResponse {
  content?: Array<{ text?: string }>;
  usage?: Record<string, unknown>;
}

export class BedrockInvocationError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BedrockInvocationError";
    this.status = status;
  }
}

export function isMantleModel(model: string): boolean {
  return model.startsWith("anthropic.");
}

function invocationModel(model: string): string {
  if (model === "anthropic.claude-opus-4-8") {
    return "us.anthropic.claude-opus-4-8";
  }
  return model;
}

function candidateRegions(region: string, model: string): string[] {
  if (!model.startsWith("us.") && !model.startsWith("global.")) {
    return [region];
  }
  return Array.from(new Set([region, "us-east-2", "us-east-1", "us-west-2"]));
}

function supportsTemperature(model: string): boolean {
  return !model.includes("claude-opus-4-8");
}

function canTryAnotherRegion(status: number, message: string): boolean {
  return (status === 403 || status === 404)
    && /not available|does not exist|not found/i.test(message);
}

function upstreamMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      message?: string;
      error?: { message?: string };
    };
    return parsed.error?.message ?? parsed.message ?? raw.slice(0, 500);
  } catch {
    return raw.slice(0, 500);
  }
}

export type BedrockStreamEvent =
  | { type: "text"; text: string }
  | { type: "usage"; usage: Record<string, unknown> };

interface EventStreamFrame {
  messageType: string;
  eventType: string;
  exceptionType: string;
  payload: Record<string, unknown>;
}

/**
 * Decode the header block of an eventstream frame into a name→string map. Each
 * header is: [1B nameLen][name][1B valueType][...value]. We only need the string
 * headers (:message-type, :event-type, :exception-type), which use value type 7
 * ([2B len][utf8]); other value types are skipped by their fixed/typed length.
 */
function decodeFrameHeaders(bytes: Uint8Array, decoder: TextDecoder): Record<string, string> {
  const headers: Record<string, string> = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const nameLen = view.getUint8(offset);
    offset += 1;
    const name = decoder.decode(bytes.subarray(offset, offset + nameLen));
    offset += nameLen;
    const valueType = view.getUint8(offset);
    offset += 1;
    if (valueType === 7) {
      const valueLen = view.getUint16(offset);
      offset += 2;
      headers[name] = decoder.decode(bytes.subarray(offset, offset + valueLen));
      offset += valueLen;
    } else {
      // Non-string header value; advance by its typed width. Bedrock only uses
      // string headers for the fields we read, so treat the rest as opaque.
      const widths: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 6: view.getUint16(offset) + 2, 8: 8, 9: 16 };
      offset += widths[valueType] ?? bytes.length;
    }
  }
  return headers;
}

/**
 * Parse an AWS `application/vnd.amazon.eventstream` byte stream (returned by the
 * Bedrock Runtime `converse-stream` endpoint) and yield each frame's type and
 * JSON payload. Each frame is: [4B totalLen][4B headersLen][4B preludeCrc][headers][payload][4B msgCrc].
 * The header block carries `:message-type` (`event` vs `exception`) and, for
 * errors, `:exception-type`; we surface those so mid-stream failures are not
 * silently dropped.
 */
async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<EventStreamFrame> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        const merged = new Uint8Array(buffer.length + value.length);
        merged.set(buffer);
        merged.set(value, buffer.length);
        buffer = merged;
      }
      // Drain every complete frame currently in the buffer.
      while (buffer.length >= 12) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const totalLen = view.getUint32(0);
        if (totalLen < 16 || totalLen > 8_000_000) {
          // Corrupt framing — stop rather than loop forever.
          return;
        }
        if (buffer.length < totalLen) {
          break;
        }
        const headersLen = view.getUint32(4);
        const headerBytes = buffer.subarray(12, 12 + headersLen);
        const frameHeaders = decodeFrameHeaders(headerBytes, decoder);
        const payloadStart = 12 + headersLen;
        const payloadEnd = totalLen - 4;
        if (payloadStart <= payloadEnd) {
          const payloadBytes = buffer.subarray(payloadStart, payloadEnd);
          const text = decoder.decode(payloadBytes);
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // Non-JSON frame (e.g. a ping); yield with empty payload.
          }
          yield {
            messageType: frameHeaders[":message-type"] ?? "event",
            eventType: frameHeaders[":event-type"] ?? "",
            exceptionType: frameHeaders[":exception-type"] ?? "",
            payload,
          };
        }
        buffer = buffer.subarray(totalLen);
      }
      if (done) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Stream assistant text token-by-token from Bedrock (Mantle SSE or Runtime eventstream). */
export async function* streamBedrockMessages(
  options: BedrockInvocationOptions,
): AsyncGenerator<BedrockStreamEvent> {
  const model = invocationModel(options.model);

  if (isMantleModel(model)) {
    const response = await fetch(
      `https://bedrock-mantle.${options.region}.api.aws/anthropic/v1/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": options.token,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        signal: options.signal,
        body: JSON.stringify({
          model,
          max_tokens: options.maxTokens,
          ...(supportsTemperature(model) ? { temperature: options.temperature } : {}),
          system: options.system,
          messages: options.messages,
          stream: true,
        }),
      },
    );
    if (!response.ok || !response.body) {
      throw new BedrockInvocationError(upstreamMessage(await response.text()), response.status || 502);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(0), { stream: !done });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of event.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data) as {
              type?: string;
              delta?: { text?: string };
              usage?: Record<string, unknown>;
              message?: { usage?: Record<string, unknown> };
              error?: { message?: string; type?: string };
            };
            if (parsed.type === "error" || parsed.error) {
              // Mantle/Anthropic emits a mid-stream `error` event on throttling or
              // an overloaded model; surface it instead of ending silently.
              throw new BedrockInvocationError(
                parsed.error?.message ?? "The model stream returned an error.",
                502,
              );
            }
            if (parsed.delta?.text) {
              yield { type: "text", text: parsed.delta.text };
            }
            const usage = parsed.usage ?? parsed.message?.usage;
            if (usage) {
              yield { type: "usage", usage };
            }
          } catch (error) {
            if (error instanceof BedrockInvocationError) {
              throw error;
            }
            // Ignore malformed SSE payloads.
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    return;
  }

  let lastError: BedrockInvocationError | null = null;
  for (const region of candidateRegions(options.region, model)) {
    const response = await fetch(
      `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse-stream`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
        },
        signal: options.signal,
        body: JSON.stringify({
          system: [{ text: options.system }],
          messages: options.messages.map((message) => ({
            role: message.role,
            content: [{ text: message.content }],
          })),
          inferenceConfig: {
            maxTokens: options.maxTokens,
            ...(supportsTemperature(model) ? { temperature: options.temperature } : {}),
          },
        }),
      },
    );
    if (!response.ok || !response.body) {
      const message = upstreamMessage(await response.text());
      lastError = new BedrockInvocationError(message, response.status || 502);
      if (canTryAnotherRegion(response.status, message)) {
        continue;
      }
      throw lastError;
    }
    for await (const frame of parseEventStream(response.body)) {
      if (frame.messageType === "exception" || frame.exceptionType) {
        // A mid-stream exception frame (throttling, model timeout) — surface it
        // rather than truncating the reply with no explanation.
        const detail = typeof frame.payload.message === "string" ? frame.payload.message : "";
        throw new BedrockInvocationError(
          `${frame.exceptionType || "Model stream error"}${detail ? `: ${detail}` : ""}`,
          502,
        );
      }
      const delta = frame.payload.delta as { text?: string } | undefined;
      if (delta?.text) {
        yield { type: "text", text: delta.text };
      }
      const metadata = frame.payload.usage as Record<string, unknown> | undefined;
      if (metadata) {
        yield { type: "usage", usage: metadata };
      }
    }
    return;
  }
  throw lastError ?? new BedrockInvocationError("No compatible Bedrock region was available.", 503);
}

export async function invokeBedrockMessages(options: BedrockInvocationOptions): Promise<{
  content: string;
  usage: Record<string, unknown> | null;
  endpoint: "mantle" | "runtime";
  region: string;
}> {
  const model = invocationModel(options.model);
  if (isMantleModel(model)) {
    const response = await fetch(
      `https://bedrock-mantle.${options.region}.api.aws/anthropic/v1/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": options.token,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        signal: options.signal,
        body: JSON.stringify({
          model,
          max_tokens: options.maxTokens,
          ...(supportsTemperature(model) ? { temperature: options.temperature } : {}),
          system: options.system,
          messages: options.messages,
        }),
      },
    );
    const raw = await response.text();
    if (!response.ok) {
      throw new BedrockInvocationError(upstreamMessage(raw), response.status);
    }
    const payload = JSON.parse(raw) as MantleResponse;
    const content = payload.content?.map((block) => block.text ?? "").join("\n").trim() ?? "";
    return { content, usage: payload.usage ?? null, endpoint: "mantle", region: options.region };
  }

  let lastError: BedrockInvocationError | null = null;
  for (const region of candidateRegions(options.region, model)) {
    const inferenceConfig = {
      maxTokens: options.maxTokens,
      ...(supportsTemperature(model) ? { temperature: options.temperature } : {}),
    };
    const response = await fetch(
      `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`,
      {
        method: "POST",
        headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
      },
      signal: options.signal,
      body: JSON.stringify({
        system: [{ text: options.system }],
        messages: options.messages.map((message) => ({
          role: message.role,
          content: [{ text: message.content }],
        })),
        inferenceConfig: {
          ...inferenceConfig,
        },
      }),
      },
    );
    const raw = await response.text();
    if (!response.ok) {
      const message = upstreamMessage(raw);
      lastError = new BedrockInvocationError(message, response.status);
      if (canTryAnotherRegion(response.status, message)) {
        continue;
      }
      throw lastError;
    }
    const payload = JSON.parse(raw) as RuntimeResponse;
    const content = payload.output?.message?.content?.map((block) => block.text ?? "").join("\n").trim() ?? "";
    return { content, usage: payload.usage ?? null, endpoint: "runtime", region };
  }
  throw lastError ?? new BedrockInvocationError("No compatible Bedrock region was available.", 503);
}
