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
  usage: Record<string, unknown> | null;
  endpoint: "mantle" | "runtime";
}> {
  if (isMantleModel(options.model)) {
    const response = await fetch(
      `https://bedrock-mantle.${options.region}.api.aws/anthropic/v1/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": options.token,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: options.maxTokens,
          temperature: options.temperature,
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
    return { content, usage: payload.usage ?? null, endpoint: "mantle" };
  }

  const response = await fetch(
    `https://bedrock-runtime.${options.region}.amazonaws.com/model/${encodeURIComponent(options.model)}/converse`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        system: [{ text: options.system }],
        messages: options.messages.map((message) => ({
          role: message.role,
          content: [{ text: message.content }],
        })),
        inferenceConfig: {
          maxTokens: options.maxTokens,
          temperature: options.temperature,
        },
      }),
    },
  );
  const raw = await response.text();
  if (!response.ok) {
    throw new BedrockInvocationError(upstreamMessage(raw), response.status);
  }
  const payload = JSON.parse(raw) as RuntimeResponse;
  const content = payload.output?.message?.content?.map((block) => block.text ?? "").join("\n").trim() ?? "";
  return { content, usage: payload.usage ?? null, endpoint: "runtime" };
}
