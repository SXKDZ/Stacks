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
    return { content, endpoint: "mantle", region: options.region };
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
    return { content, endpoint: "runtime", region };
  }
  throw lastError ?? new BedrockInvocationError("No compatible Bedrock region was available.", 503);
}
