import {
  BedrockInvocationError,
  invokeBedrockMessages,
} from "@/app/lib/bedrock";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface InferenceProfileSummary {
  inferenceProfileId?: string;
  inferenceProfileName?: string;
  status?: string;
}

interface InferenceProfilesResponse {
  inferenceProfileSummaries?: InferenceProfileSummary[];
  message?: string;
}

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

function upstreamMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { message?: string };
    return parsed.message ?? raw.slice(0, 500);
  } catch {
    return raw.slice(0, 500);
  }
}

export async function GET(): Promise<Response> {
  const runtime = await resolveRuntimeValues();
  const token = runtimeValue(runtime, "AWS_BEARER_TOKEN_BEDROCK");
  if (!token) {
    return Response.json({ error: "AWS_BEARER_TOKEN_BEDROCK is not configured." }, { status: 500 });
  }
  const region = runtimeValue(runtime, "AWS_REGION", "us-east-1");
  const [profilesResponse, mantleResponse] = await Promise.all([
    fetch(`https://bedrock.${region}.amazonaws.com/inference-profiles?maxResults=1000&type=SYSTEM_DEFINED`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }),
    fetch(`https://bedrock-mantle.${region}.api.aws/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }),
  ]);
  const profilesRaw = await profilesResponse.text();
  const mantleRaw = await mantleResponse.text();
  if (!profilesResponse.ok && !mantleResponse.ok) {
    return Response.json({ error: upstreamMessage(profilesRaw || mantleRaw) }, { status: 502 });
  }
  const payload = profilesResponse.ok ? JSON.parse(profilesRaw) as InferenceProfilesResponse : {};
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
  const mantlePayload = mantleResponse.ok ? JSON.parse(mantleRaw) as { data?: Array<{ id?: string }> } : {};
  const runtimeProfileIds = new Set(profileModels.map((model) => model.id));
  const mantleModels = (mantlePayload.data ?? [])
    .filter((model) => model.id?.startsWith("anthropic."))
    .filter((model) => !runtimeProfileIds.has(`us.${model.id}`))
    .map((model) => {
      const id = model.id ?? "";
      const label = id
        .replace(/^anthropic\./, "")
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ")
        .replace(/\b(\d+) (\d+)\b/g, "$1.$2");
      return {
        id,
        label: `${label} · Mantle`,
        name: label,
        scope: "Mantle" as const,
        status: "ACTIVE",
        endpoint: "mantle" as const,
      };
    });
  const models = [...mantleModels, ...profileModels]
    .sort((left, right) => {
      if (left.scope !== right.scope) {
        return left.scope === "US" ? -1 : right.scope === "US" ? 1 : left.scope === "Global" ? -1 : right.scope === "Global" ? 1 : 0;
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
  const body = await request.json() as { modelId?: string };
  const modelId = body.modelId?.trim();
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
      maxTokens: 8,
      temperature: 0,
    });
    return Response.json({
      available: true,
      modelId,
      endpoint: result.endpoint,
      region: result.region,
      message: `This credential can invoke the selected model through ${result.region}.`,
    });
  } catch (error) {
    if (error instanceof BedrockInvocationError) {
      return Response.json({ available: false, modelId, message: error.message });
    }
    throw error;
  }
}
