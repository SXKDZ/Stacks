const runtimeKeys = [
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "BEDROCK_MODEL_ID",
  "JINA_API_KEY",
  "PA_MAX_TOKENS",
  "PA_CHAT_SYSTEM_PROMPT",
  "PA_EXTRACTION_SYSTEM_PROMPT",
  "PA_SUMMARY_SYSTEM_PROMPT",
  "PA_TEMPERATURE",
  "SEMANTIC_SCHOLAR_API_KEY",
  "SERPAPI_KEY",
] as const;

export type RuntimeValues = Record<string, string>;

function environmentValues(): RuntimeValues {
  return Object.fromEntries(runtimeKeys.map((key) => [key, process.env[key]?.trim() ?? ""]));
}

function isLocalRequest(request: Request): boolean {
  try {
    const hostname = new URL(request.url).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export async function resolveRuntimeValues(request: Request): Promise<RuntimeValues> {
  const values = environmentValues();
  if (!isLocalRequest(request)) {
    return values;
  }
  try {
    const response = await fetch(new URL("/api/local-runtime-settings", request.url), {
      headers: { "x-pa-internal-runtime": "pa-runtime-v1" },
      cache: "no-store",
    });
    if (!response.ok) {
      return values;
    }
    const payload = await response.json() as { values?: RuntimeValues };
    for (const key of runtimeKeys) {
      if (typeof payload.values?.[key] === "string") {
        values[key] = payload.values[key];
      }
    }
  } catch {
    // Hosted deployments and isolated runtimes continue using deployment variables.
  }
  return values;
}

export function runtimeValue(values: RuntimeValues, key: string, fallback = ""): string {
  return values[key]?.trim() || fallback;
}
