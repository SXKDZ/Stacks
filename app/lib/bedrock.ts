import { parseJsonWith } from "@/app/lib/schemas/parse";
import { joinTextBlocks, MantleResponseSchema, OpenAIResponsesResponseSchema, openAIResponseText, RuntimeResponseSchema, UpstreamErrorSchema } from "@/app/lib/schemas/bedrock";
import { bedrockEffortFields, type EffortSetting } from "@/app/lib/effort";

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
  /**
   * Reasoning effort ("" or absent = don't ask for any).
   *
   * Runtime models receive Bedrock's `thinking`/`output_config` fields. OpenAI
   * Responses models receive `reasoning.effort`. Left unset it is omitted
   * entirely, so models that do not support the setting are unaffected.
   */
  effort?: EffortSetting;
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

/**
 * Mantle Responses model IDs do not carry Bedrock Runtime's version suffix
 * (`:0`). This keeps the older OpenAI open-weight Runtime IDs on Converse while
 * routing current frontier models through their OpenAI-compatible endpoint.
 */
export function isOpenAIResponsesModel(model: string): boolean {
  return model.startsWith("openai.") && !model.includes(":");
}

function invocationModel(model: string): string {
  if (model === "anthropic.claude-opus-4-8") {
    return "us.anthropic.claude-opus-4-8";
  }
  return model;
}

function candidateRegions(region: string, model: string): string[] {
  if (isOpenAIResponsesModel(model)) {
    const supported = model === "openai.gpt-5.6-sol"
      ? ["us-east-1", "us-east-2"]
      : ["us-east-1", "us-east-2", "us-west-2"];
    return supported.includes(region)
      ? [region, ...supported.filter((candidate) => candidate !== region)]
      : supported;
  }
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
  const message = parsed.ok
    ? parsed.data.error?.message ?? parsed.data.message ?? raw.slice(0, 500)
    : raw.slice(0, 500);
  // Name the setting to change. "output_config.effort: Extra inputs are not
  // permitted" is the provider saying this model has no reasoning control, which
  // reads as a bug rather than a setting the user can turn off.
  if (/output_config\.effort|thinking\.type/.test(message)) {
    return `${message} This model does not support reasoning effort: turn it off in Settings, or choose a newer model.`;
  }
  return message;
}

export async function invokeBedrockMessages(options: BedrockInvocationOptions): Promise<{
  content: string;
  endpoint: "mantle" | "runtime";
  region: string;
}> {
  const model = invocationModel(options.model);
  if (isOpenAIResponsesModel(model)) {
    let lastError: BedrockInvocationError | null = null;
    for (const region of candidateRegions(options.region, model)) {
      const response = await fetch(
        `https://bedrock-mantle.${region}.api.aws/openai/v1/responses`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.token}`,
            "Content-Type": "application/json",
          },
          signal: options.signal,
          body: JSON.stringify({
            model,
            instructions: options.system,
            input: options.messages,
            max_output_tokens: options.maxTokens,
            store: false,
            ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
            ...(options.effort ? { reasoning: { effort: options.effort } } : {}),
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
      const payload = parseJsonWith(OpenAIResponsesResponseSchema, raw);
      if (!payload.ok) {
        throw new BedrockInvocationError(`Unexpected Bedrock response: ${payload.error}`, 502);
      }
      const content = openAIResponseText(payload.data);
      if (!content) {
        throw new BedrockInvocationError("The OpenAI Responses API returned no answer text.", 502);
      }
      return { content, endpoint: "mantle", region };
    }
    throw lastError ?? new BedrockInvocationError("No compatible Bedrock region was available.", 503);
  }
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
    const fields = bedrockEffortFields(options.effort ?? "");
    const effortFields = Object.keys(fields).length ? fields : null;
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
        ...(effortFields ? { additionalModelRequestFields: effortFields } : {}),
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
