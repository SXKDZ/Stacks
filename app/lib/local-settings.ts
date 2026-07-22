import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
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
  libraryName?: string;
  modelId?: string;
  region?: string;
  maxTokens?: string | number;
  temperature?: string | number;
  extractionSystemPrompt?: string;
  summarySystemPrompt?: string;
  remotePath?: string;
  autoSync?: boolean;
  autoSyncInterval?: string | number;
  githubRepo?: string;
  secrets?: Record<string, string>;
}

interface StructuredSettingsFile {
  version: 1;
  updatedAt: string;
  /** The user-facing library name shown in the sidebar status. */
  libraryName?: string;
  ai: {
    modelId: string;
    region: string;
    maxTokens: string;
    temperature: string;
  };
  prompts: {
    extractionSystem: string;
    summarySystem: string;
  };
  sync: {
    remotePath: string;
    autoSync: string;
    autoSyncInterval: string;
  };
  github?: {
    repo: string;
    /** ISO timestamp of the last successful inbox sync, for incremental pulls. */
    lastSyncedAt?: string;
  };
  feedSkills?: Array<{ id: string; label: string; icon: string; prompt: string }>;
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
  "STACKS_LIBRARY_NAME",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "BEDROCK_MODEL_ID",
  "STACKS_MAX_TOKENS",
  "STACKS_EXTRACTION_SYSTEM_PROMPT",
  "STACKS_SUMMARY_SYSTEM_PROMPT",
  "STACKS_TEMPERATURE",
  "STACKS_AUTO_SYNC",
  "STACKS_AUTO_SYNC_INTERVAL",
  "STACKS_ONEDRIVE_PATH",
  "STACKS_GITHUB_REPO",
  "SEMANTIC_SCHOLAR_API_KEY",
  "SERPAPI_KEY",
  "GITHUB_TOKEN",
]);

const secretKeys = [
  "AWS_BEARER_TOKEN_BEDROCK",
  "SEMANTIC_SCHOLAR_API_KEY",
  "SERPAPI_KEY",
  "GITHUB_TOKEN",
] as const;

const bridgePath = join(process.cwd(), "scripts", "stacks_sync_bridge.py");
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
    STACKS_LIBRARY_NAME: settings.libraryName,
    AWS_BEARER_TOKEN_BEDROCK: settings.secrets.AWS_BEARER_TOKEN_BEDROCK,
    AWS_REGION: settings.ai.region,
    BEDROCK_MODEL_ID: settings.ai.modelId,
    STACKS_MAX_TOKENS: settings.ai.maxTokens,
    STACKS_EXTRACTION_SYSTEM_PROMPT: settings.prompts.extractionSystem,
    STACKS_SUMMARY_SYSTEM_PROMPT: settings.prompts.summarySystem,
    STACKS_TEMPERATURE: settings.ai.temperature,
    STACKS_AUTO_SYNC: settings.sync.autoSync,
    STACKS_AUTO_SYNC_INTERVAL: settings.sync.autoSyncInterval,
    STACKS_ONEDRIVE_PATH: settings.sync.remotePath,
    STACKS_GITHUB_REPO: settings.github?.repo,
    SEMANTIC_SCHOLAR_API_KEY: settings.secrets.SEMANTIC_SCHOLAR_API_KEY,
    SERPAPI_KEY: settings.secrets.SERPAPI_KEY,
    GITHUB_TOKEN: settings.secrets.GITHUB_TOKEN,
  };
  return values[key];
}

function envValue(key: string, fallback = ""): string {
  return (structuredValue(readStructuredSettings(), key) ?? process.env[key] ?? fallback).trim();
}

// The runtime keys the AI routes read (model, prompts, secrets, region, etc.).
// This is the single source that resolveRuntimeValues layers over process.env,
// resolved from settings.json — there is no separate app_settings store.
const runtimeKeys = [
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "BEDROCK_MODEL_ID",
  "STACKS_MAX_TOKENS",
  "STACKS_EXTRACTION_SYSTEM_PROMPT",
  "STACKS_SUMMARY_SYSTEM_PROMPT",
  "STACKS_TEMPERATURE",
  "STACKS_GITHUB_REPO",
  "SEMANTIC_SCHOLAR_API_KEY",
  "SERPAPI_KEY",
  "GITHUB_TOKEN",
] as const;

/** The persisted runtime values (from settings.json) for the AI routes. */
export function runtimeValues(): Record<string, string> {
  const settings = readStructuredSettings();
  const values: Record<string, string> = {};
  for (const key of runtimeKeys) {
    const value = structuredValue(settings, key);
    if (value?.trim()) {
      values[key] = value.trim();
    }
  }
  return values;
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
    ? "Choose the OneDrive folder for Stacks sync"
    : target === "storage"
      ? "Choose the destination folder for the Stacks library"
      : "Choose the local Stacks data folder containing papers.db";
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
    // Preserve the library name across unrelated settings writes.
    libraryName: existing?.libraryName,
    ai: {
      modelId: envValue("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6"),
      region: envValue("AWS_REGION", "us-east-1"),
      maxTokens: envValue("STACKS_MAX_TOKENS", "10000"),
      temperature: envValue("STACKS_TEMPERATURE", "0.25"),
    },
    prompts: {
      extractionSystem: envValue("STACKS_EXTRACTION_SYSTEM_PROMPT", DEFAULT_EXTRACTION_SYSTEM_PROMPT),
      summarySystem: envValue("STACKS_SUMMARY_SYSTEM_PROMPT", DEFAULT_SUMMARY_SYSTEM_PROMPT),
    },
    sync: {
      remotePath: envValue("STACKS_ONEDRIVE_PATH"),
      autoSync: envValue("STACKS_AUTO_SYNC", "false"),
      autoSyncInterval: envValue("STACKS_AUTO_SYNC_INTERVAL", "5"),
    },
    github: {
      repo: envValue("STACKS_GITHUB_REPO"),
      // Preserve the sync high-water mark across unrelated settings writes.
      lastSyncedAt: existing?.github?.lastSyncedAt,
    },
    // Seed the secret baseline from the persisted settings file ONLY (no env
    // fallback). Otherwise a secret supplied purely through the environment
    // would be silently materialized into plaintext settings.json the first
    // time any unrelated setting is saved. Secrets are persisted only when the
    // user enters them in the UI (they then arrive via the request payload).
    // Preserve any saved feed skills across unrelated settings writes.
    feedSkills: existing?.feedSkills,
    secrets: Object.fromEntries(
      secretKeys.map((key) => [key, existing?.secrets?.[key]?.trim() ?? ""]),
    ),
  };
}

/** Read the user's saved feed skills (undefined if none saved yet). */
export function readFeedSkills(): Array<{ id: string; label: string; icon: string; prompt: string }> | undefined {
  return readStructuredSettings()?.feedSkills;
}

/** Persist the feed skills, preserving the rest of settings.json. */
export function writeFeedSkills(skills: Array<{ id: string; label: string; icon: string; prompt: string }>): void {
  const next = settingsFromCurrentValues(readStructuredSettings());
  next.feedSkills = skills;
  writeStructuredSettings(next);
}

/** The high-water mark of the last successful GitHub inbox sync (or undefined). */
export function readGithubLastSyncedAt(): string | undefined {
  return readStructuredSettings()?.github?.lastSyncedAt;
}

/** Record when the GitHub inbox sync last completed, preserving the rest. */
export function writeGithubLastSyncedAt(iso: string): void {
  const next = settingsFromCurrentValues(readStructuredSettings());
  next.github = { repo: next.github?.repo ?? "", lastSyncedAt: iso };
  writeStructuredSettings(next);
}

function saveStructuredSettings(updates: Record<string, string>): void {
  const next = settingsFromCurrentValues(readStructuredSettings());
  const setValue = (key: string, value: string) => {
    switch (key) {
      case "BEDROCK_MODEL_ID": next.ai.modelId = value; break;
      case "AWS_REGION": next.ai.region = value; break;
      case "STACKS_MAX_TOKENS": next.ai.maxTokens = value; break;
      case "STACKS_TEMPERATURE": next.ai.temperature = value; break;
      case "STACKS_EXTRACTION_SYSTEM_PROMPT": next.prompts.extractionSystem = value; break;
      case "STACKS_SUMMARY_SYSTEM_PROMPT": next.prompts.summarySystem = value; break;
      case "STACKS_ONEDRIVE_PATH": next.sync.remotePath = value; break;
      case "STACKS_AUTO_SYNC": next.sync.autoSync = value; break;
      case "STACKS_AUTO_SYNC_INTERVAL": next.sync.autoSyncInterval = value; break;
      case "STACKS_GITHUB_REPO": next.github = { repo: value }; break;
      case "STACKS_LIBRARY_NAME": next.libraryName = value; break;
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
  writeStructuredSettings(next);
}

/** Atomically write the structured settings.json (temp file + rename). */
function writeStructuredSettings(next: StructuredSettingsFile): void {
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
    libraryName: readStructuredSettings()?.libraryName?.trim() || "My Paper Library",
    ai: {
      provider: "bedrock",
      modelId: envValue("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6"),
      region: envValue("AWS_REGION", "us-east-1"),
      maxTokens: Number(envValue("STACKS_MAX_TOKENS", "10000")) || 10000,
      temperature: Number(envValue("STACKS_TEMPERATURE", "0.25")) || 0,
    },
    integrations: Object.fromEntries(
      secretKeys.map((key) => [key, Boolean(envValue(key))]),
    ),
    prompts: {
      extractionSystem: envValue("STACKS_EXTRACTION_SYSTEM_PROMPT", DEFAULT_EXTRACTION_SYSTEM_PROMPT),
      summarySystem: envValue("STACKS_SUMMARY_SYSTEM_PROMPT", DEFAULT_SUMMARY_SYSTEM_PROMPT),
    },
    sync: {
      remotePath: envValue("STACKS_ONEDRIVE_PATH"),
      autoSync: truthy(envValue("STACKS_AUTO_SYNC", "false")),
      autoSyncInterval: Number(envValue("STACKS_AUTO_SYNC_INTERVAL", "5")) || 5,
      detectedPaths: detectOneDrivePaths(),
      running: syncRunning,
      lastSyncAt,
      lastResult: lastSyncResult,
      sourceExists: Boolean(databaseSource()),
    },
    github: {
      repo: envValue("STACKS_GITHUB_REPO"),
      connected: Boolean(envValue("GITHUB_TOKEN")),
    },
  };
}

function sanitizeSettings(data: SettingsPayload): Record<string, string> {
  // Every field falls back to its CURRENTLY SAVED value (envValue reads
  // settings.json first) when the payload omits it, so a partial save never
  // resets an untouched field to a hardcoded default. Numeric/boolean fields
  // are clamped only when the payload actually supplies them.
  const clampInt = (value: unknown, saved: string, min: number, max: number, fallback: number): string => {
    if (value === undefined || value === null || value === "") return saved || String(fallback);
    const n = Number(value);
    if (!Number.isFinite(n)) return saved || String(fallback);
    return String(Math.min(max, Math.max(min, Math.round(n))));
  };
  const clampFloat = (value: unknown, saved: string, min: number, max: number, fallback: number): string => {
    if (value === undefined || value === null || value === "") return saved || String(fallback);
    const n = Number(value);
    if (!Number.isFinite(n)) return saved || String(fallback);
    return String(Math.min(max, Math.max(min, n)));
  };
  const updates: Record<string, string> = {
    STACKS_LIBRARY_NAME: String(data.libraryName ?? envValue("STACKS_LIBRARY_NAME", "My Paper Library")).trim().slice(0, 60) || "My Paper Library",
    BEDROCK_MODEL_ID: String(data.modelId ?? envValue("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6")).trim(),
    AWS_REGION: String(data.region ?? envValue("AWS_REGION", "us-east-1")).trim(),
    STACKS_MAX_TOKENS: clampInt(data.maxTokens, envValue("STACKS_MAX_TOKENS", "10000"), 128, 200000, 10000),
    STACKS_EXTRACTION_SYSTEM_PROMPT: String(data.extractionSystemPrompt ?? envValue("STACKS_EXTRACTION_SYSTEM_PROMPT", DEFAULT_EXTRACTION_SYSTEM_PROMPT)).trim(),
    STACKS_SUMMARY_SYSTEM_PROMPT: String(data.summarySystemPrompt ?? envValue("STACKS_SUMMARY_SYSTEM_PROMPT", DEFAULT_SUMMARY_SYSTEM_PROMPT)).trim(),
    STACKS_TEMPERATURE: clampFloat(data.temperature, envValue("STACKS_TEMPERATURE", "0.25"), 0, 1, 0.25),
    STACKS_ONEDRIVE_PATH: String(data.remotePath ?? envValue("STACKS_ONEDRIVE_PATH")).trim(),
    // autoSync is a real boolean in the payload; only fall back to the saved
    // value when it's omitted entirely (undefined), not when it's an explicit false.
    STACKS_AUTO_SYNC: data.autoSync === undefined ? envValue("STACKS_AUTO_SYNC", "false") : data.autoSync ? "true" : "false",
    STACKS_AUTO_SYNC_INTERVAL: clampInt(data.autoSyncInterval, envValue("STACKS_AUTO_SYNC_INTERVAL", "5"), 5, 3600, 5),
    STACKS_GITHUB_REPO: String(data.githubRepo ?? envValue("STACKS_GITHUB_REPO")).trim(),
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
    throw new Error("A Stacks backup is already running.");
  }
  const localDatabase = databaseSource();
  const remoteDirectory = envValue("STACKS_ONEDRIVE_PATH");
  if (!localDatabase) {
    throw new Error("The local Stacks database is not available yet.");
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
          rejectResult(new Error("Stacks sync timed out after 5 minutes."));
          return;
        }
        try {
          const lines = output.trim().split(/\r?\n/).filter(Boolean);
          const parsed = JSON.parse(lines.at(-1) ?? "{}") as SyncResult;
          if (!parsed.summary) {
            throw new Error(errorOutput.trim() || "Stacks sync returned no result.");
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

// Debounced auto-backup. When "Auto-back up after live Stacks changes" is on,
// each mutation calls scheduleAutoSync(); a burst of edits coalesces into one
// backup that runs once the library has been quiet for `autoSyncInterval`
// seconds. Runs server-side on the always-on Node process, so it works with no
// browser tab open. Failures are swallowed (best-effort background backup).
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
let autoSyncPending = false;

export function scheduleAutoSync(): void {
  const sync = currentSettings().sync;
  if (!sync.autoSync || !sync.sourceExists || !sync.remotePath.trim()) {
    return;
  }
  // Clamp to the same 5–3600s bounds the settings writer enforces.
  const seconds = Math.min(3600, Math.max(5, Number(sync.autoSyncInterval) || 5));
  if (autoSyncTimer) {
    clearTimeout(autoSyncTimer);
  }
  autoSyncTimer = setTimeout(() => {
    autoSyncTimer = null;
    void fireAutoSync();
  }, seconds * 1000);
  // Don't keep the process alive solely for a pending backup.
  if (typeof autoSyncTimer === "object" && autoSyncTimer && "unref" in autoSyncTimer) {
    (autoSyncTimer as { unref: () => void }).unref();
  }
}

async function fireAutoSync(): Promise<void> {
  // If a backup is already mid-flight, remember to re-run once it settles so the
  // edits that arrived during it aren't lost; otherwise run now.
  if (syncRunning) {
    autoSyncPending = true;
    return;
  }
  try {
    await runSync(true);
  } catch {
    // Best-effort: a failed background backup must not crash the mutation path.
  } finally {
    if (autoSyncPending) {
      autoSyncPending = false;
      scheduleAutoSync();
    }
  }
}
