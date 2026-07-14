import {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_SUMMARY_SYSTEM_PROMPT,
} from "@/app/lib/ai-prompts";

export const dynamic = "force-dynamic";

function configured(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

export async function GET(): Promise<Response> {
  return Response.json({
    local: false,
    ai: {
      provider: "bedrock",
      modelId: process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6",
      region: process.env.AWS_REGION ?? "us-east-1",
      maxTokens: Number(process.env.PA_MAX_TOKENS ?? 1200),
      temperature: Number(process.env.PA_TEMPERATURE ?? 0.25),
    },
    integrations: {
      AWS_BEARER_TOKEN_BEDROCK: configured("AWS_BEARER_TOKEN_BEDROCK"),
      JINA_API_KEY: configured("JINA_API_KEY"),
      SEMANTIC_SCHOLAR_API_KEY: configured("SEMANTIC_SCHOLAR_API_KEY"),
      SERPAPI_KEY: configured("SERPAPI_KEY"),
    },
    prompts: {
      chatSystem: process.env.PA_CHAT_SYSTEM_PROMPT ?? DEFAULT_CHAT_SYSTEM_PROMPT,
      summarySystem: process.env.PA_SUMMARY_SYSTEM_PROMPT ?? DEFAULT_SUMMARY_SYSTEM_PROMPT,
    },
    sync: {
      localDataDir: process.env.PAPERCLI_DATA_DIR ?? "~/.papercli",
      remotePath: "",
      autoSync: false,
      autoSyncInterval: 5,
      conflictPolicy: "keep_both",
      detectedPaths: [],
      running: false,
      lastSyncAt: null,
      lastResult: null,
      sourceExists: false,
    },
  });
}

export async function POST(): Promise<Response> {
  return Response.json(
    { error: "Hosted settings are managed through deployment environment variables." },
    { status: 501 },
  );
}
