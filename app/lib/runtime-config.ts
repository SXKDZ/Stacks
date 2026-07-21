const runtimeKeys = [
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "BEDROCK_MODEL_ID",
  "STACKS_MAX_TOKENS",
  "STACKS_EXTRACTION_SYSTEM_PROMPT",
  "STACKS_SUMMARY_SYSTEM_PROMPT",
  "STACKS_TEMPERATURE",
  "SEMANTIC_SCHOLAR_API_KEY",
  "SERPAPI_KEY",
] as const;

export type RuntimeValues = Record<string, string>;

function environmentValues(): RuntimeValues {
  return Object.fromEntries(runtimeKeys.map((key) => [key, process.env[key]?.trim() ?? ""]));
}

export async function resolveRuntimeValues(): Promise<RuntimeValues> {
  // Note: no longer takes a Request — runtime values resolve from env + the
  // library settings.json regardless of the incoming request.
  // Start from process.env, then layer the self-contained library settings
  // (AI config, prompts, and secrets from settings.json) on top. Running on a
  // single Node process, this resolves everything from the library folder with
  // no host/localhost gating — the AI routes get the token wherever they run.
  const values = environmentValues();
  try {
    const { runtimeValues } = await import("@/app/lib/local-settings");
    Object.assign(values, runtimeValues());
  } catch {
    // A settings-free runtime can still use deployment environment values.
  }
  return values;
}

export function runtimeValue(values: RuntimeValues, key: string, fallback = ""): string {
  return values[key]?.trim() || fallback;
}
