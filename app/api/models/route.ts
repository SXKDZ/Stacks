import {
  BedrockInvocationError,
  isOpenAIResponsesModel,
  invokeBedrockMessages,
} from "@/app/lib/bedrock";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import { parseJsonWith, parseRequest } from "@/app/lib/schemas/parse";
import { ModelSelectionRequestSchema } from "@/app/lib/schemas/requests";
import { InferenceProfilesResponseSchema, MantleModelListSchema, UpstreamErrorSchema } from "@/app/lib/schemas/bedrock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function profileScope(id: string): "US" | "Global" | "Other" {
  if (id.startsWith("us.")) {
    return "US";
  }
  if (id.startsWith("global.")) {
    return "Global";
  }
  return "Other";
}

function profileLabel(name: string, id: string): string {
  const cleaned = name
    .replace(/^GLOBAL\s+/i, "")
    .replace(/^US\s+/i, "")
    .replace(/^Anthropic\s+/i, "")
    .replace(/^Claude\s+/i, "Claude ");
  return `${cleaned || id} · ${profileScope(id)}`;
}

const GPT_56_MODELS = [
  { id: "openai.gpt-5.6-sol", label: "GPT-5.6 Sol · OpenAI" },
  { id: "openai.gpt-5.6-terra", label: "GPT-5.6 Terra · OpenAI" },
  { id: "openai.gpt-5.6-luna", label: "GPT-5.6 Luna · OpenAI" },
] as const;

function mantleLabel(id: string): string {
  const known = GPT_56_MODELS.find((model) => model.id === id);
  if (known) return known.label;
  const [provider, ...nameParts] = id.split(".");
  const name = nameParts.join(".")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .replace(/\b(\d+) (\d+)\b/g, "$1.$2");
  return `${name || id} · ${provider === "openai" ? "OpenAI" : "Mantle"}`;
}

function gpt56Rank(id: string): number {
  const index = GPT_56_MODELS.findIndex((model) => model.id === id);
  return index === -1 ? GPT_56_MODELS.length : index;
}

function upstreamMessage(raw: string): string {
  const parsed = parseJsonWith(UpstreamErrorSchema, raw);
  return (parsed.ok ? parsed.data.error?.message ?? parsed.data.message : undefined) ?? raw.slice(0, 500);
}

export async function GET(): Promise<Response> {
  const runtime = await resolveRuntimeValues();
  const token = runtimeValue(runtime, "AWS_BEARER_TOKEN_BEDROCK");
  if (!token) {
    return Response.json({ error: "AWS_BEARER_TOKEN_BEDROCK is not configured." }, { status: 500 });
  }
  const region = runtimeValue(runtime, "AWS_REGION", "us-east-1");
  const [profilesResponse, mantleResponse, openAIResponse] = await Promise.all([
    fetch(`https://bedrock.${region}.amazonaws.com/inference-profiles?maxResults=1000&type=SYSTEM_DEFINED`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }),
    fetch(`https://bedrock-mantle.${region}.api.aws/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }),
    fetch(`https://bedrock-mantle.${region}.api.aws/openai/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }),
  ]);
  const profilesRaw = await profilesResponse.text();
  const mantleRaw = await mantleResponse.text();
  const openAIRaw = await openAIResponse.text();
  if (!profilesResponse.ok && !mantleResponse.ok && !openAIResponse.ok) {
    return Response.json({ error: upstreamMessage(profilesRaw || mantleRaw || openAIRaw) }, { status: 502 });
  }
  // A catalogue we can't parse yields no models from that endpoint rather than
  // throwing: the other endpoint's list is still usable.
  const profiles = profilesResponse.ok ? parseJsonWith(InferenceProfilesResponseSchema, profilesRaw) : null;
  const payload = profiles?.ok ? profiles.data : {};
  const profileModels = (payload.inferenceProfileSummaries ?? [])
    .filter((profile) => profile.status === "ACTIVE" && profile.inferenceProfileId?.includes(".anthropic."))
    .map((profile) => {
      const id = profile.inferenceProfileId ?? "";
      return {
        id,
        label: profileLabel(profile.inferenceProfileName ?? "", id),
        name: profile.inferenceProfileName ?? id,
        scope: profileScope(id),
        status: profile.status,
        endpoint: "runtime" as const,
      };
    });
  const mantleParsed = mantleResponse.ok ? parseJsonWith(MantleModelListSchema, mantleRaw) : null;
  const mantlePayload = mantleParsed?.ok ? mantleParsed.data : {};
  const runtimeProfileIds = new Set(profileModels.map((model) => model.id));
  const mantleModels = (mantlePayload.data ?? [])
    .filter((model) => model.id?.startsWith("anthropic."))
    .filter((model) => !runtimeProfileIds.has(`us.${model.id}`))
    .map((model) => {
      const id = model.id ?? "";
      const label = mantleLabel(id);
      return {
        id,
        label,
        name: label,
        scope: "Mantle" as const,
        status: "ACTIVE",
        endpoint: "mantle" as const,
      };
    });
  const openAIParsed = openAIResponse.ok ? parseJsonWith(MantleModelListSchema, openAIRaw) : null;
  const discoveredOpenAI = (openAIParsed?.ok ? openAIParsed.data.data : []) ?? [];
  const openAIIds = new Set(discoveredOpenAI
    .map((model) => model.id)
    .filter((id): id is string => Boolean(id && isOpenAIResponsesModel(id))));
  // GPT-5.6 is included even while an account is awaiting model verification.
  // The adjacent Test access action remains authoritative for the credential.
  for (const model of GPT_56_MODELS) openAIIds.add(model.id);
  const openAIModels = [...openAIIds].map((id) => ({
    id,
    label: mantleLabel(id),
    name: mantleLabel(id),
    scope: "OpenAI" as const,
    status: "ACTIVE",
    endpoint: "mantle" as const,
  }));
  const models = [...openAIModels, ...mantleModels, ...profileModels]
    .sort((left, right) => {
      const gptOrder = gpt56Rank(left.id) - gpt56Rank(right.id);
      if (left.scope === "OpenAI" && right.scope === "OpenAI" && gptOrder) {
        return gptOrder;
      }
      if (left.scope !== right.scope) {
        // Frontier OpenAI models first, then Runtime profiles, then the remaining
        // Mantle catalogue.
        const rank = (scope: string) => (scope === "OpenAI" ? 0 : scope === "US" ? 1 : scope === "Global" ? 2 : 3);
        return rank(left.scope) - rank(right.scope);
      }
      return right.label.localeCompare(left.label, undefined, { numeric: true });
    });
  return Response.json({ models, region, source: "bedrock-model-catalogs" });
}

export async function POST(request: Request): Promise<Response> {
  const runtime = await resolveRuntimeValues();
  const token = runtimeValue(runtime, "AWS_BEARER_TOKEN_BEDROCK");
  if (!token) {
    return Response.json({ error: "AWS_BEARER_TOKEN_BEDROCK is not configured." }, { status: 500 });
  }
  const parsed = await parseRequest(ModelSelectionRequestSchema, request);
  const modelId = parsed.ok ? parsed.data.modelId?.trim() : "";
  if (!modelId) {
    return Response.json({ error: "Choose a model before testing access." }, { status: 400 });
  }
  const region = runtimeValue(runtime, "AWS_REGION", "us-east-1");
  try {
    const result = await invokeBedrockMessages({
      token,
      region,
      model: modelId,
      system: "This is a model-access health check.",
      messages: [{ role: "user", content: "Reply only with OK." }],
      maxTokens: 32,
      signal: request.signal,
      // No temperature: this only asks "can this credential invoke this model", and
      // a model that rejects the parameter would otherwise report itself as
      // inaccessible when access was never the problem.
    });
    return Response.json({
      available: true,
      modelId,
      endpoint: result.endpoint,
      region: result.region,
      message: `Your Bedrock key can use this model through ${isOpenAIResponsesModel(modelId) ? "the Responses API" : result.endpoint === "mantle" ? "the Messages API" : "the Converse API"} in ${result.region}.`,
    });
  } catch (error) {
    if (error instanceof BedrockInvocationError) {
      return Response.json({ available: false, modelId, message: error.message });
    }
    throw error;
  }
}
