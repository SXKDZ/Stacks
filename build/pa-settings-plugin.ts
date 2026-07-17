import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_EXTRACTION_SYSTEM_PROMPT,
  DEFAULT_SUMMARY_SYSTEM_PROMPT,
} from "../app/lib/ai-prompts";

interface SettingsPayload {
  modelId?: string;
  region?: string;
  maxTokens?: string | number;
  temperature?: string | number;
  pdfPages?: string | number;
  chatSystemPrompt?: string;
  extractionSystemPrompt?: string;
  summarySystemPrompt?: string;
  remotePath?: string;
  autoSync?: boolean;
  autoSyncInterval?: string | number;
  secrets?: Record<string, string>;
}

interface StructuredSettingsFile {
  version: 1;
  updatedAt: string;
  ai: {
    modelId: string;
    region: string;
    maxTokens: string;
    temperature: string;
    pdfPages: string;
  };
  prompts: {
    chatSystem: string;
    extractionSystem: string;
    summarySystem: string;
  };
  sync: {
    remotePath: string;
    autoSync: string;
    autoSyncInterval: string;
  };
  secrets: Record<string, string>;
}

interface SyncResult {
  ok: boolean;
  summary: string;
  changes: Record<string, number>;
  details: Record<string, string[]>;
  conflicts: number;
  errors: string[];
  cancelled: boolean;
  progress: Array<{ message: string }>;
  logs: Array<{ action: string; details: string }>;
}

const environmentKeys = new Set([
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "BEDROCK_MODEL_ID",
  "JINA_API_KEY",
  "PA_MAX_TOKENS",
  "PA_PDF_PAGES",
  "PA_CHAT_SYSTEM_PROMPT",
  "PA_EXTRACTION_SYSTEM_PROMPT",
  "PA_SUMMARY_SYSTEM_PROMPT",
  "PA_TEMPERATURE",
  "PA_AUTO_SYNC",
  "PA_AUTO_SYNC_INTERVAL",
  "PA_ONEDRIVE_PATH",
  "SEMANTIC_SCHOLAR_API_KEY",
  "SERPAPI_KEY",
]);

const secretKeys = [
  "AWS_BEARER_TOKEN_BEDROCK",
  "JINA_API_KEY",
  "SEMANTIC_SCHOLAR_API_KEY",
  "SERPAPI_KEY",
] as const;

const paDirectory = resolve(process.cwd());
const repositoryRoot = resolve(paDirectory, "..");
const settingsDirectory = join(paDirectory, "data");
const settingsPath = join(settingsDirectory, "settings.json");
const settingsTemporaryPath = join(settingsDirectory, "settings.json.tmp");
const bridgePath = join(paDirectory, "scripts", "pa_sync_bridge.py");
const localAssetDirectory = join(paDirectory, "data");
const localD1Directory = join(
  paDirectory,
  ".wrangler",
  "state",
  "v3",
  "d1",
  "miniflare-D1DatabaseObject",
);

let syncRunning = false;
let lastSyncAt: string | null = null;
let lastSyncResult: SyncResult | null = null;
let lastObservedDatabaseTime = 0;
let pendingAutoSyncAt = 0;

function readStructuredSettings(): StructuredSettingsFile | null {
  if (!existsSync(settingsPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as StructuredSettingsFile;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function structuredValue(settings: StructuredSettingsFile | null, key: string): string | undefined {
  if (!settings) {
    return undefined;
  }
  const values: Record<string, string | undefined> = {
    AWS_BEARER_TOKEN_BEDROCK: settings.secrets.AWS_BEARER_TOKEN_BEDROCK,
    AWS_REGION: settings.ai.region,
    BEDROCK_MODEL_ID: settings.ai.modelId,
    JINA_API_KEY: settings.secrets.JINA_API_KEY,
    PA_MAX_TOKENS: settings.ai.maxTokens,
    PA_PDF_PAGES: settings.ai.pdfPages,
    PA_CHAT_SYSTEM_PROMPT: settings.prompts.chatSystem,
    PA_EXTRACTION_SYSTEM_PROMPT: settings.prompts.extractionSystem,
    PA_SUMMARY_SYSTEM_PROMPT: settings.prompts.summarySystem,
    PA_TEMPERATURE: settings.ai.temperature,
    PA_AUTO_SYNC: settings.sync.autoSync,
    PA_AUTO_SYNC_INTERVAL: settings.sync.autoSyncInterval,
    PA_ONEDRIVE_PATH: settings.sync.remotePath,
    SEMANTIC_SCHOLAR_API_KEY: settings.secrets.SEMANTIC_SCHOLAR_API_KEY,
    SERPAPI_KEY: settings.secrets.SERPAPI_KEY,
  };
  return values[key];
}

function envValue(key: string, fallback = ""): string {
  return (structuredValue(readStructuredSettings(), key) ?? process.env[key] ?? fallback).trim();
}

function truthy(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function findLocalD1Database(): string | null {
  if (!existsSync(localD1Directory)) {
    return null;
  }
  const candidates = readdirSync(localD1Directory)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => join(localD1Directory, name))
    .filter((path) => existsSync(path))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return candidates[0] ?? null;
}

function parseBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>);
      } catch (error) {
        rejectBody(error);
      }
    });
    request.on("error", rejectBody);
  });
}

function commandOutput(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += String(chunk);
    });
    child.once("error", rejectOutput);
    child.once("close", (code) => {
      if (code === 0) {
        resolveOutput(output.trim() || null);
        return;
      }
      if (/cancel|user canceled/i.test(errorOutput)) {
        resolveOutput(null);
        return;
      }
      rejectOutput(new Error(errorOutput.trim() || "The system folder selector could not be opened."));
    });
  });
}

async function chooseDirectory(target: "local" | "remote" | "storage"): Promise<string | null> {
  const prompt = target === "remote"
    ? "Choose the OneDrive folder for PA sync"
    : target === "storage"
      ? "Choose the destination folder for the PA library"
      : "Choose the local PA data folder containing papers.db";
  let selected: string | null;
  if (process.platform === "darwin") {
    selected = await commandOutput("osascript", ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`]);
  } else if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$dialog.Description = ${JSON.stringify(prompt)}`,
      "if ($dialog.ShowDialog() -eq 'OK') { Write-Output $dialog.SelectedPath }",
    ].join("; ");
    selected = await commandOutput("powershell.exe", ["-NoProfile", "-Command", script]);
  } else {
    selected = await commandOutput("zenity", ["--file-selection", "--directory", `--title=${prompt}`]);
  }
  if (!selected || selected === "/") {
    return selected;
  }
  return selected.replace(/[\\/]+$/, "");
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}

function settingsFromCurrentValues(): StructuredSettingsFile {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    ai: {
      modelId: envValue("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6"),
      region: envValue("AWS_REGION", "us-east-1"),
      maxTokens: envValue("PA_MAX_TOKENS", "1200"),
      temperature: envValue("PA_TEMPERATURE", "0.25"),
      pdfPages: envValue("PA_PDF_PAGES", "10"),
    },
    prompts: {
      chatSystem: envValue("PA_CHAT_SYSTEM_PROMPT", DEFAULT_CHAT_SYSTEM_PROMPT),
      extractionSystem: envValue("PA_EXTRACTION_SYSTEM_PROMPT", DEFAULT_EXTRACTION_SYSTEM_PROMPT),
      summarySystem: envValue("PA_SUMMARY_SYSTEM_PROMPT", DEFAULT_SUMMARY_SYSTEM_PROMPT),
    },
    sync: {
      remotePath: envValue("PA_ONEDRIVE_PATH"),
      autoSync: envValue("PA_AUTO_SYNC", "false"),
      autoSyncInterval: envValue("PA_AUTO_SYNC_INTERVAL", "5"),
    },
    secrets: Object.fromEntries(secretKeys.map((key) => [key, envValue(key)])),
  };
}

function saveStructuredSettings(updates: Record<string, string>): void {
  const next = settingsFromCurrentValues();
  const setValue = (key: string, value: string) => {
    switch (key) {
      case "BEDROCK_MODEL_ID": next.ai.modelId = value; break;
      case "AWS_REGION": next.ai.region = value; break;
      case "PA_MAX_TOKENS": next.ai.maxTokens = value; break;
      case "PA_TEMPERATURE": next.ai.temperature = value; break;
      case "PA_PDF_PAGES": next.ai.pdfPages = value; break;
      case "PA_CHAT_SYSTEM_PROMPT": next.prompts.chatSystem = value; break;
      case "PA_EXTRACTION_SYSTEM_PROMPT": next.prompts.extractionSystem = value; break;
      case "PA_SUMMARY_SYSTEM_PROMPT": next.prompts.summarySystem = value; break;
      case "PA_ONEDRIVE_PATH": next.sync.remotePath = value; break;
      case "PA_AUTO_SYNC": next.sync.autoSync = value; break;
      case "PA_AUTO_SYNC_INTERVAL": next.sync.autoSyncInterval = value; break;
      default:
        if (secretKeys.includes(key as typeof secretKeys[number])) {
          next.secrets[key] = value;
        }
    }
  };
  for (const [key, value] of Object.entries(updates)) {
    if (!environmentKeys.has(key)) {
      continue;
    }
    setValue(key, value);
    process.env[key] = value;
  }
  next.updatedAt = new Date().toISOString();
  mkdirSync(settingsDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(settingsTemporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(settingsTemporaryPath, settingsPath);
  chmodSync(settingsPath, 0o600);
}

function detectOneDrivePaths(): string[] {
  const candidates = new Set<string>();
  for (const key of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
    const value = process.env[key];
    if (value && existsSync(value)) {
      candidates.add(resolve(value));
    }
  }
  const homeCandidate = join(homedir(), "OneDrive");
  if (existsSync(homeCandidate)) {
    candidates.add(homeCandidate);
  }
  const cloudStorage = join(homedir(), "Library", "CloudStorage");
  if (existsSync(cloudStorage)) {
    for (const name of readdirSync(cloudStorage)) {
      if (name.toLowerCase().startsWith("onedrive")) {
        candidates.add(join(cloudStorage, name));
      }
    }
  }
  return [...candidates].sort();
}

function currentSettings() {
  const localD1Database = findLocalD1Database();
  return {
    local: true,
    ai: {
      provider: "bedrock",
      modelId: envValue("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6"),
      region: envValue("AWS_REGION", "us-east-1"),
      maxTokens: Number(envValue("PA_MAX_TOKENS", "1200")) || 1200,
      temperature: Number(envValue("PA_TEMPERATURE", "0.25")) || 0,
      pdfPages: Math.min(20, Math.max(1, Number(envValue("PA_PDF_PAGES", "10")) || 10)),
    },
    integrations: Object.fromEntries(
      secretKeys.map((key) => [key, Boolean(envValue(key))]),
    ),
    prompts: {
      chatSystem: envValue("PA_CHAT_SYSTEM_PROMPT", DEFAULT_CHAT_SYSTEM_PROMPT),
      extractionSystem: envValue("PA_EXTRACTION_SYSTEM_PROMPT", DEFAULT_EXTRACTION_SYSTEM_PROMPT),
      summarySystem: envValue("PA_SUMMARY_SYSTEM_PROMPT", DEFAULT_SUMMARY_SYSTEM_PROMPT),
    },
    sync: {
      remotePath: envValue("PA_ONEDRIVE_PATH"),
      autoSync: truthy(envValue("PA_AUTO_SYNC", "false")),
      autoSyncInterval: Number(envValue("PA_AUTO_SYNC_INTERVAL", "5")) || 5,
      detectedPaths: detectOneDrivePaths(),
      running: syncRunning,
      lastSyncAt,
      lastResult: lastSyncResult,
      sourceExists: Boolean(localD1Database),
    },
  };
}

function sanitizeSettings(data: SettingsPayload): Record<string, string> {
  const updates: Record<string, string> = {
    BEDROCK_MODEL_ID: String(data.modelId ?? envValue("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6")).trim(),
    AWS_REGION: String(data.region ?? envValue("AWS_REGION", "us-east-1")).trim(),
    PA_MAX_TOKENS: String(Math.max(128, Number(data.maxTokens) || 1200)),
    PA_PDF_PAGES: String(Math.min(20, Math.max(1, Number(data.pdfPages) || 10))),
    PA_CHAT_SYSTEM_PROMPT: String(data.chatSystemPrompt ?? envValue("PA_CHAT_SYSTEM_PROMPT", DEFAULT_CHAT_SYSTEM_PROMPT)).trim(),
    PA_EXTRACTION_SYSTEM_PROMPT: String(data.extractionSystemPrompt ?? envValue("PA_EXTRACTION_SYSTEM_PROMPT", DEFAULT_EXTRACTION_SYSTEM_PROMPT)).trim(),
    PA_SUMMARY_SYSTEM_PROMPT: String(data.summarySystemPrompt ?? envValue("PA_SUMMARY_SYSTEM_PROMPT", DEFAULT_SUMMARY_SYSTEM_PROMPT)).trim(),
    PA_TEMPERATURE: String(Math.min(1, Math.max(0, Number(data.temperature) || 0))),
    PA_ONEDRIVE_PATH: String(data.remotePath ?? envValue("PA_ONEDRIVE_PATH")).trim(),
    PA_AUTO_SYNC: data.autoSync ? "true" : "false",
    PA_AUTO_SYNC_INTERVAL: String(Math.min(3600, Math.max(5, Number(data.autoSyncInterval) || 5))),
  };
  for (const key of secretKeys) {
    const replacement = data.secrets?.[key]?.trim();
    if (replacement) {
      updates[key] = replacement;
    }
  }
  return updates;
}

function pythonExecutable(): string {
  const virtualEnvironmentPython = process.platform === "win32"
    ? join(repositoryRoot, ".venv", "Scripts", "python.exe")
    : join(repositoryRoot, ".venv", "bin", "python");
  if (existsSync(virtualEnvironmentPython)) {
    return virtualEnvironmentPython;
  }
  return process.platform === "win32" ? "python" : "python3";
}

async function runSync(auto = false): Promise<SyncResult> {
  if (syncRunning) {
    throw new Error("A PA sync is already running.");
  }
  const localDatabase = findLocalD1Database();
  const remoteDirectory = envValue("PA_ONEDRIVE_PATH");
  if (!localDatabase) {
    throw new Error("The local PA D1 database is not available yet.");
  }
  if (!remoteDirectory) {
    throw new Error("Choose a OneDrive remote directory before syncing.");
  }
  syncRunning = true;
  try {
    const result = await new Promise<SyncResult>((resolveResult, rejectResult) => {
      const args = [
        bridgePath,
        "--local",
        localAssetDirectory,
        "--database",
        localDatabase,
        "--remote",
        remoteDirectory,
        "--policy",
        "local",
      ];
      if (auto) {
        args.push("--auto");
      }
      const child = spawn(pythonExecutable(), args, {
        cwd: repositoryRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let errorOutput = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.length > 2_000_000) {
          child.kill();
        }
      });
      child.stderr.on("data", (chunk) => {
        errorOutput += String(chunk);
      });
      child.on("error", rejectResult);
      child.on("close", () => {
        try {
          const lines = output.trim().split(/\r?\n/).filter(Boolean);
          const parsed = JSON.parse(lines.at(-1) ?? "{}") as SyncResult;
          if (!parsed.summary) {
            throw new Error(errorOutput.trim() || "PA sync returned no result.");
          }
          resolveResult(parsed);
        } catch (error) {
          rejectResult(error);
        }
      });
    });
    lastSyncAt = new Date().toISOString();
    lastSyncResult = result;
    return result;
  } finally {
    syncRunning = false;
  }
}

export function paSettings(): Plugin {
  return {
    name: "pa-local-settings",
    apply: "serve",
    configureServer(server) {
      const observeDatabase = () => {
        const settings = currentSettings();
        const databasePath = findLocalD1Database();
        if (!settings.sync.autoSync || !settings.sync.remotePath || !databasePath) {
          return;
        }
        const modified = statSync(databasePath).mtimeMs;
        if (!lastObservedDatabaseTime) {
          lastObservedDatabaseTime = modified;
          return;
        }
        if (modified > lastObservedDatabaseTime) {
          lastObservedDatabaseTime = modified;
          pendingAutoSyncAt = Date.now() + settings.sync.autoSyncInterval * 1000;
        }
        if (pendingAutoSyncAt && Date.now() >= pendingAutoSyncAt && !syncRunning) {
          pendingAutoSyncAt = 0;
          void runSync(true).catch((error) => {
            lastSyncAt = new Date().toISOString();
            lastSyncResult = {
              ok: false,
              summary: "Auto-sync failed",
              changes: {},
              details: {},
              conflicts: 0,
              errors: [error instanceof Error ? error.message : "Auto-sync failed."],
              cancelled: false,
              progress: [],
              logs: [],
            };
          });
        }
      };
      const timer = setInterval(observeDatabase, 1000);
      server.httpServer?.once("close", () => clearInterval(timer));

      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname === "/api/local-directory-picker") {
          if (request.method !== "POST") {
            sendJson(response, { error: "Use POST to choose a directory." }, 405);
            return;
          }
          try {
            const body = await parseBody(request);
            const target = body.target === "local" ? "local" : body.target === "storage" ? "storage" : "remote";
            const path = await chooseDirectory(target);
            sendJson(response, {
              path,
              sourceExists: target === "local" && path ? existsSync(join(path, "papers.db")) : undefined,
            });
          } catch (error) {
            sendJson(response, { error: error instanceof Error ? error.message : "The folder selector could not be opened." }, 500);
          }
          return;
        }
        if (url.pathname === "/api/local-settings") {
          try {
            if (request.method === "POST") {
              const body = await parseBody(request);
              saveStructuredSettings(sanitizeSettings((body.data ?? {}) as SettingsPayload));
            }
            sendJson(response, currentSettings());
          } catch (error) {
            sendJson(response, { error: error instanceof Error ? error.message : "Settings could not be saved." }, 400);
          }
          return;
        }
        if (url.pathname === "/api/local-runtime-settings") {
          const hasBrowserHeaders = Boolean(request.headers.origin || request.headers["sec-fetch-site"]);
          if (request.method !== "GET" || request.headers["x-pa-internal-runtime"] !== "pa-runtime-v1" || hasBrowserHeaders) {
            sendJson(response, { error: "Internal runtime configuration is unavailable." }, 403);
            return;
          }
          sendJson(response, {
            values: Object.fromEntries([...environmentKeys].map((key) => [key, envValue(key)])),
          });
          return;
        }
        if (url.pathname === "/api/local-sync") {
          if (request.method === "GET") {
            sendJson(response, currentSettings().sync);
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await parseBody(request);
              if (body.data && typeof body.data === "object") {
                saveStructuredSettings(sanitizeSettings(body.data as SettingsPayload));
              }
              const result = await runSync(false);
              sendJson(response, { result, sync: currentSettings().sync }, result.ok ? 200 : 502);
            } catch (error) {
              sendJson(response, { error: error instanceof Error ? error.message : "Sync failed.", sync: currentSettings().sync }, 502);
            }
            return;
          }
        }
        next();
      });
    },
  };
}
