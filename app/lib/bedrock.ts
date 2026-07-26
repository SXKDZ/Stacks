import { parseJsonWith } from "@/app/lib/schemas/parse";
import { joinTextBlocks, MantleResponseSchema, RuntimeResponseSchema, UpstreamErrorSchema } from "@/app/lib/schemas/bedrock";

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
  /**
   * Omitted from the request entirely when undefined.
   *
   * Some models reject the parameter ("`temperature` is deprecated for this
   * model") rather than ignoring it, and nothing in a model id says which, so the
   * caller decides from the user's setting instead of a hardcoded model list that
   * goes stale with every release.
   */
  temperature?: number;
  signal?: AbortSignal;
}

export class BedrockInvocationError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BedrockInvocationError";
    this.status = status;
  }
}

/**
 * The temperature to send, or undefined to omit the parameter.
 *
 * `enabled` is the user's "Send temperature" setting: models that reject the
 * parameter cannot be identified from their id, so this is a switch rather than a
 * list to keep updated.
 */
export function temperatureOption(enabled: boolean, value: number): number | undefined {
  return enabled ? Math.min(1, Math.max(0, value)) : undefined;
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

function canTryAnotherRegion(status: number, message: string): boolean {
  return (status === 403 || status === 404)
    && /not available|does not exist|not found/i.test(message);
}

function upstreamMessage(raw: string): string {
  const parsed = parseJsonWith(UpstreamErrorSchema, raw);
  if (!parsed.ok) {
    return raw.slice(0, 500);
  }
  return parsed.data.error?.message ?? parsed.data.message ?? raw.slice(0, 500);
}

export async function invokeBedrockMessages(options: BedrockInvocationOptions): Promise<{
  content: string;
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
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          system: options.system,
          messages: options.messages,
        }),
      },
    );
    const raw = await response.text();
    if (!response.ok) {
      throw new BedrockInvocationError(upstreamMessage(raw), response.status);
    }
    // Validate rather than cast: a shape we don't recognize is reported instead
    // of silently collapsing to an empty completion via optional chaining.
    const payload = parseJsonWith(MantleResponseSchema, raw);
    if (!payload.ok) {
      throw new BedrockInvocationError(`Unexpected Bedrock response: ${payload.error}`, 502);
    }
    return { content: joinTextBlocks(payload.data.content), endpoint: "mantle", region: options.region };
  }

  let lastError: BedrockInvocationError | null = null;
  for (const region of candidateRegions(options.region, model)) {
    const inferenceConfig = {
      maxTokens: options.maxTokens,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
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
    const payload = parseJsonWith(RuntimeResponseSchema, raw);
    if (!payload.ok) {
      throw new BedrockInvocationError(`Unexpected Bedrock response: ${payload.error}`, 502);
    }
    return { content: joinTextBlocks(payload.data.output?.message?.content), endpoint: "runtime", region };
  }
  throw lastError ?? new BedrockInvocationError("No compatible Bedrock region was available.", 503);
}
