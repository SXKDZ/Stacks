import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_EXTRACTION_SYSTEM_PROMPT,
  DEFAULT_SUMMARY_SYSTEM_PROMPT,
} from "@/app/lib/ai-prompts";
import { databasePath, ensureLibraryDirectories, libraryRoot, settingsPath } from "@/db/library-paths";

/**
 * Local settings companion. The structured `settings.json` (AI config, prompts,
 * sync, secrets) lives in the self-contained library folder via
 * `settingsPath()`, alongside `library.db`. The OneDrive sync bridge backs up
 * the live `library.db` (resolved through `databasePath()`).
 */

export interface SettingsPayload {
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

export interface SyncResult {
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
  "SEMANTIC_SCHOLAR_API_KEY",
  "SERPAPI_KEY",
] as const;

const bridgePath = join(process.cwd(), "scripts", "pa_sync_bridge.py");
const repositoryRoot = resolve(process.cwd(), "..");

let syncRunning = false;
let lastSyncAt: string | null = null;
let lastSyncResult: SyncResult | null = null;

function readStructuredSettings(): StructuredSettingsFile | null {
  const path = settingsPath();
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StructuredSettingsFile;
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

function databaseSource(): string | null {
  const path = databasePath();
  return existsSync(path) ? path : null;
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

export async function chooseDirectory(target: "local" | "remote" | "storage"): Promise<string | null> {
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

function settingsFromCurrentValues(existing: StructuredSettingsFile | null): StructuredSettingsFile {
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
    // Seed the secret baseline from the persisted settings file ONLY (no env
    // fallback). Otherwise a secret supplied purely through the environment
    // would be silently materialized into plaintext settings.json the first
    // time any unrelated setting is saved. Secrets are persisted only when the
    // user enters them in the UI (they then arrive via the request payload).
    secrets: Object.fromEntries(
      secretKeys.map((key) => [key, existing?.secrets?.[key]?.trim() ?? ""]),
    ),
  };
}

function saveStructuredSettings(updates: Record<string, string>): void {
  const next = settingsFromCurrentValues(readStructuredSettings());
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
  ensureLibraryDirectories();
  const path = settingsPath();
  const temporaryPath = join(dirname(path), "settings.json.tmp");
  writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
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

export function currentSettings() {
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
      sourceExists: Boolean(databaseSource()),
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

export function persistSettings(data: SettingsPayload): void {
  saveStructuredSettings(sanitizeSettings(data));
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

export async function runSync(auto = false): Promise<SyncResult> {
  if (syncRunning) {
    throw new Error("A PA backup is already running.");
  }
  const localDatabase = databaseSource();
  const remoteDirectory = envValue("PA_ONEDRIVE_PATH");
  if (!localDatabase) {
    throw new Error("The local PA database is not available yet.");
  }
  if (!remoteDirectory) {
    throw new Error("Choose a OneDrive backup folder first.");
  }
  // Choosing the path and starting a backup is the user's authorization to
  // create the folder, so a not-yet-existing destination is created here (its
  // parent must already exist, so a typo can't scatter a tree at a phantom
  // path). A non-empty folder is fine: the backup is one-way and additive —
  // it only writes library.db + pdfs/ + html_snapshots/ and never deletes other
  // contents. The one hard rule is that the destination must be outside the
  // live library folder, or the backup would clobber the source it copies.
  const resolvedRemote = resolve(remoteDirectory);
  const resolvedLibrary = resolve(libraryRoot());
  if (resolvedRemote === resolvedLibrary || resolvedRemote.startsWith(`${resolvedLibrary}/`)) {
    throw new Error("The backup folder must be outside the live library folder.");
  }
  if (existsSync(resolvedRemote)) {
    if (!statSync(resolvedRemote).isDirectory()) {
      throw new Error("The OneDrive backup path is a file. Choose a folder.");
    }
  } else {
    const parent = dirname(resolvedRemote);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new Error("The OneDrive backup folder's parent does not exist. Choose a valid location.");
    }
    mkdirSync(resolvedRemote, { recursive: true });
  }
  syncRunning = true;
  try {
    const result = await new Promise<SyncResult>((resolveResult, rejectResult) => {
      const args = [
        bridgePath,
        "--local",
        libraryRoot(),
        "--database",
        localDatabase,
        "--remote",
        resolvedRemote,
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
      let timedOut = false;
      // Never let a stuck bridge (network stall, lock contention) hang the sync
      // request forever; SIGKILL after 5 minutes and surface a clear error.
      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 5 * 60 * 1000);
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.length > 2_000_000) {
          child.kill();
        }
      });
      child.stderr.on("data", (chunk) => {
        errorOutput += String(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(killTimer);
        rejectResult(error);
      });
      child.on("close", () => {
        clearTimeout(killTimer);
        if (timedOut) {
          rejectResult(new Error("PA sync timed out after 5 minutes."));
          return;
        }
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
