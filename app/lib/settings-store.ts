import { existsSync, readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_EXTRACTION_SYSTEM_PROMPT,
  DEFAULT_SUMMARY_SYSTEM_PROMPT,
} from "@/app/lib/ai-prompts";
import { ensureDatabase } from "@/db/bootstrap";
import { settingsPath } from "@/db/library-paths";
import { appSettings } from "@/db/schema";

const SECRET_KEYS = ["AWS_BEARER_TOKEN_BEDROCK", "JINA_API_KEY", "SEMANTIC_SCHOLAR_API_KEY", "SERPAPI_KEY"] as const;

interface LibrarySettingsFile {
  ai?: { modelId?: string; region?: string; maxTokens?: string; temperature?: string; pdfPages?: string };
  prompts?: { chatSystem?: string; extractionSystem?: string; summarySystem?: string };
  sync?: { remotePath?: string; autoSync?: string; autoSyncInterval?: string };
  secrets?: Partial<Record<(typeof SECRET_KEYS)[number], string>>;
}

/**
 * Read the self-contained library settings.json (AI config, prompts, sync, and
 * secrets). This file lives in the library folder alongside library.db, so the
 * app resolves everything — including API keys — from one place with no
 * host/localhost gating.
 */
function readLibrarySettingsFile(): LibrarySettingsFile | null {
  try {
    const path = settingsPath();
    if (!existsSync(path)) {
      return null;
    }
    return JSON.parse(readFileSync(path, "utf8")) as LibrarySettingsFile;
  } catch {
    return null;
  }
}

/** A secret's value: prefer the library settings.json, fall back to env. */
function secretValue(file: LibrarySettingsFile | null, key: (typeof SECRET_KEYS)[number]): string {
  return (file?.secrets?.[key]?.trim() || process.env[key]?.trim() || "");
}

export interface SettingsInput {
  modelId?: unknown;
  region?: unknown;
  maxTokens?: unknown;
  temperature?: unknown;
  pdfPages?: unknown;
  chatSystemPrompt?: unknown;
  extractionSystemPrompt?: unknown;
  summarySystemPrompt?: unknown;
  remotePath?: unknown;
  autoSync?: unknown;
  autoSyncInterval?: unknown;
}

interface StoredSettings {
  version: 1;
  ai: {
    modelId: string;
    region: string;
    maxTokens: number;
    temperature: number;
    pdfPages: number;
  };
  prompts: {
    chatSystem: string;
    extractionSystem: string;
    summarySystem: string;
  };
  sync: {
    remotePath: string;
    autoSync: boolean;
    autoSyncInterval: number;
  };
}

const SETTINGS_ID = "primary";

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function number(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function environmentDefaults(): StoredSettings {
  return {
    version: 1,
    ai: {
      modelId: process.env.BEDROCK_MODEL_ID?.trim() || "us.anthropic.claude-sonnet-4-6",
      region: process.env.AWS_REGION?.trim() || "us-east-1",
      maxTokens: number(process.env.PA_MAX_TOKENS, 1200, 128, 32_000),
      temperature: number(process.env.PA_TEMPERATURE, 0.25, 0, 1),
      pdfPages: number(process.env.PA_PDF_PAGES, 10, 1, 20),
    },
    prompts: {
      chatSystem: process.env.PA_CHAT_SYSTEM_PROMPT?.trim() || DEFAULT_CHAT_SYSTEM_PROMPT,
      extractionSystem: process.env.PA_EXTRACTION_SYSTEM_PROMPT?.trim() || DEFAULT_EXTRACTION_SYSTEM_PROMPT,
      summarySystem: process.env.PA_SUMMARY_SYSTEM_PROMPT?.trim() || DEFAULT_SUMMARY_SYSTEM_PROMPT,
    },
    sync: {
      remotePath: process.env.PA_ONEDRIVE_PATH?.trim() || "",
      autoSync: ["1", "true", "yes", "on"].includes((process.env.PA_AUTO_SYNC ?? "").toLowerCase()),
      autoSyncInterval: number(process.env.PA_AUTO_SYNC_INTERVAL, 5, 5, 3600),
    },
  };
}

function normalizeStoredSettings(value: unknown): StoredSettings {
  const fallback = environmentDefaults();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const candidate = value as Partial<StoredSettings>;
  return {
    version: 1,
    ai: {
      modelId: text(candidate.ai?.modelId, fallback.ai.modelId),
      region: text(candidate.ai?.region, fallback.ai.region),
      maxTokens: number(candidate.ai?.maxTokens, fallback.ai.maxTokens, 128, 32_000),
      temperature: number(candidate.ai?.temperature, fallback.ai.temperature, 0, 1),
      pdfPages: number(candidate.ai?.pdfPages, fallback.ai.pdfPages, 1, 20),
    },
    prompts: {
      chatSystem: text(candidate.prompts?.chatSystem, fallback.prompts.chatSystem),
      extractionSystem: text(candidate.prompts?.extractionSystem, fallback.prompts.extractionSystem),
      summarySystem: text(candidate.prompts?.summarySystem, fallback.prompts.summarySystem),
    },
    sync: {
      remotePath: typeof candidate.sync?.remotePath === "string" ? candidate.sync.remotePath.trim() : fallback.sync.remotePath,
      autoSync: typeof candidate.sync?.autoSync === "boolean" ? candidate.sync.autoSync : fallback.sync.autoSync,
      autoSyncInterval: number(candidate.sync?.autoSyncInterval, fallback.sync.autoSyncInterval, 5, 3600),
    },
  };
}

export async function readStoredSettings(): Promise<StoredSettings> {
  const database = await ensureDatabase();
  const row = database
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ID))
    .get();
  if (!row?.value) {
    return environmentDefaults();
  }
  try {
    return normalizeStoredSettings(JSON.parse(row.value));
  } catch {
    return environmentDefaults();
  }
}

export async function saveStoredSettings(input: SettingsInput): Promise<StoredSettings> {
  const current = await readStoredSettings();
  const next = normalizeStoredSettings({
    version: 1,
    ai: {
      modelId: input.modelId ?? current.ai.modelId,
      region: input.region ?? current.ai.region,
      maxTokens: input.maxTokens ?? current.ai.maxTokens,
      temperature: input.temperature ?? current.ai.temperature,
      pdfPages: input.pdfPages ?? current.ai.pdfPages,
    },
    prompts: {
      chatSystem: input.chatSystemPrompt ?? current.prompts.chatSystem,
      extractionSystem: input.extractionSystemPrompt ?? current.prompts.extractionSystem,
      summarySystem: input.summarySystemPrompt ?? current.prompts.summarySystem,
    },
    sync: {
      remotePath: input.remotePath ?? current.sync.remotePath,
      autoSync: typeof input.autoSync === "boolean" ? input.autoSync : current.sync.autoSync,
      autoSyncInterval: input.autoSyncInterval ?? current.sync.autoSyncInterval,
    },
  });
  const database = await ensureDatabase();
  database
    .insert(appSettings)
    .values({ id: SETTINGS_ID, value: JSON.stringify(next) })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { value: sql`excluded.value`, updatedAt: sql`CURRENT_TIMESTAMP` },
    })
    .run();
  return next;
}

export function settingsSnapshot(settings: StoredSettings) {
  const file = readLibrarySettingsFile();
  const configured = (name: (typeof SECRET_KEYS)[number]) => Boolean(secretValue(file, name));
  return {
    local: true,
    ai: { provider: "bedrock", ...settings.ai },
    integrations: {
      AWS_BEARER_TOKEN_BEDROCK: configured("AWS_BEARER_TOKEN_BEDROCK"),
      JINA_API_KEY: configured("JINA_API_KEY"),
      SEMANTIC_SCHOLAR_API_KEY: configured("SEMANTIC_SCHOLAR_API_KEY"),
      SERPAPI_KEY: configured("SERPAPI_KEY"),
    },
    prompts: settings.prompts,
    sync: {
      ...settings.sync,
      detectedPaths: [],
      running: false,
      lastSyncAt: null,
      lastResult: null,
      sourceExists: false,
      available: false,
      unavailableReason: "OneDrive folder sync requires PA's local filesystem companion.",
    },
  };
}

export async function storedRuntimeValues(): Promise<Record<string, string>> {
  const settings = await readStoredSettings();
  const file = readLibrarySettingsFile();
  const values: Record<string, string> = {
    AWS_REGION: settings.ai.region,
    BEDROCK_MODEL_ID: settings.ai.modelId,
    PA_MAX_TOKENS: String(settings.ai.maxTokens),
    PA_TEMPERATURE: String(settings.ai.temperature),
    PA_PDF_PAGES: String(settings.ai.pdfPages),
    PA_CHAT_SYSTEM_PROMPT: settings.prompts.chatSystem,
    PA_EXTRACTION_SYSTEM_PROMPT: settings.prompts.extractionSystem,
    PA_SUMMARY_SYSTEM_PROMPT: settings.prompts.summarySystem,
  };
  // Secrets come from the library settings.json (or env); include only the ones
  // that resolve to a value so callers can fall back to process.env otherwise.
  for (const key of SECRET_KEYS) {
    const value = secretValue(file, key);
    if (value) {
      values[key] = value;
    }
  }
  return values;
}
