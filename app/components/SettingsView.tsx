"use client";

import {
  ArrowRightLeft,
  Bot,
  Check,
  Cloud,
  Cpu,
  CloudCog,
  ChevronDown,
  DatabaseBackup,
  FileWarning,
  FolderOpen,
  FolderSync,
  HardDrive,
  Info,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  Moon,
  Palette,
  RefreshCw,
  Save,
  ScanSearch,
  ShieldCheck,
  Sun,
  Trash2,
  Users,
  Wrench,
} from "lucide-react";
import type { FormEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_EXTRACTION_SYSTEM_PROMPT,
  DEFAULT_SUMMARY_SYSTEM_PROMPT,
} from "@/app/lib/ai-prompts";
import { useBackgroundTasks } from "@/app/components/BackgroundTasks";
import { ActionButton, ActionLink, SelectCard, TabButton } from "@/app/components/ui/controls";
import type { Paper } from "@/app/lib/types";

type SettingsTab = "appearance" | "model" | "prompts" | "storage" | "sync" | "integrations" | "about";
type ThemeMode = "dark" | "light";

interface SyncResult {
  ok: boolean;
  summary: string;
  changes: Record<string, number>;
  conflicts: number;
  errors: string[];
}

interface SettingsSnapshot {
  local: boolean;
  ai: {
    provider: string;
    modelId: string;
    region: string;
    maxTokens: number;
    temperature: number;
    pdfPages: number;
  };
  integrations: Record<string, boolean>;
  prompts: {
    chatSystem: string;
    extractionSystem: string;
    summarySystem: string;
  };
  sync: {
    remotePath: string;
    autoSync: boolean;
    autoSyncInterval: number;
    detectedPaths: string[];
    running: boolean;
    lastSyncAt: string | null;
    lastResult: SyncResult | null;
    sourceExists: boolean;
    available?: boolean;
    unavailableReason?: string;
  };
}

interface BedrockModelOption {
  id: string;
  label: string;
  endpoint: "mantle" | "runtime";
  scope: string;
}

interface ModelAccessResult {
  available: boolean;
  modelId: string;
  message: string;
  endpoint?: "mantle" | "runtime";
  region?: string;
}

interface VersionInfo {
  currentVersion: string;
  checked: boolean;
  latestVersion?: string | null;
  updateAvailable?: boolean;
  releaseName?: string;
  releaseUrl?: string | null;
  publishedAt?: string | null;
  message?: string;
}

interface StorageReport {
  mode?: "local" | "hosted";
  capabilities?: {
    databaseChecks: boolean;
    fileChecks: boolean;
    repairs: string[];
    folderMove: boolean;
  };
  libraryRoot: string;
  libraryExists: boolean;
  databasePresent: boolean;
  settingsPresent: boolean;
  paperRecords: number;
  referencedPdfFiles: number;
  presentPdfFiles: number;
  missingPdfFiles: number;
  missingPdfPaths: string[];
  invalidPdfPaths: string[];
  referencedHtmlFiles: number;
  presentHtmlFiles: number;
  missingHtmlFiles: number;
  missingHtmlPaths: string[];
  invalidHtmlPaths: string[];
  invalidReferences: number;
  papersWithoutLocalAsset: number;
  paperIdsWithoutLocalAsset: string[];
  storedPdfFiles: number;
  storedPdfBytes: number;
  storedHtmlFiles: number;
  storedHtmlBytes: number;
  totalFiles: number;
  totalBytes: number;
  orphanedFiles: number;
  orphanedBytes: number;
  protectedOrphanedFiles?: number;
  removedFiles: number;
  removedBytes: number;
  databaseHealth?: {
    integrityOk: boolean;
    integrityMessages: string[];
    foreignKeyEnforced: boolean;
    foreignKeyViolations: number;
    tableCounts: Record<string, number>;
    orphanedAssociations: {
      paperAuthors: number;
      paperCollections: number;
      paperTags: number;
    };
    orphanedEntities?: {
      authors: number;
      venues: number;
      collections: number;
    };
    absolutePdfPaths: string[];
    absoluteHtmlPaths: string[];
    repairSummary?: {
      orphanedAssociations: number;
      portablePaths: number;
      renamedPdfs: number;
      skippedRepairs: number;
      migratedLegacyFiles?: number;
    };
  };
  systemHealth?: {
    runtime: string;
    database: string;
    filesystemAvailable: boolean;
    freeBytes?: number;
    platform?: string;
    claudeCli?: string | null;
  };
}

interface PromptVariableDefinition {
  token: string;
  description: string;
}

type PromptKey = "chatSystem" | "summarySystem" | "extractionSystem";

const defaultSettings: SettingsSnapshot = {
  local: true,
  ai: {
    provider: "bedrock",
    modelId: "us.anthropic.claude-sonnet-4-6",
    region: "us-east-1",
    maxTokens: 1200,
    temperature: 0.25,
    pdfPages: 10,
  },
  integrations: {},
  prompts: {
    chatSystem: DEFAULT_CHAT_SYSTEM_PROMPT,
    extractionSystem: DEFAULT_EXTRACTION_SYSTEM_PROMPT,
    summarySystem: DEFAULT_SUMMARY_SYSTEM_PROMPT,
  },
  sync: {
    remotePath: "",
    autoSync: false,
    autoSyncInterval: 5,
    detectedPaths: [],
    running: false,
    lastSyncAt: null,
    lastResult: null,
      sourceExists: false,
      available: true,
  },
};

const secretFields = [
  { key: "AWS_BEARER_TOKEN_BEDROCK", label: "AWS Bedrock API key", detail: "Chat and on-demand summaries" },
  { key: "SEMANTIC_SCHOLAR_API_KEY", label: "Semantic Scholar", detail: "Academic discovery and metadata" },
  { key: "SERPAPI_KEY", label: "SerpAPI", detail: "Google Scholar discovery" },
] as const;

const fallbackBedrockModels: BedrockModelOption[] = [
  { id: "us.anthropic.claude-opus-4-8", label: "Claude Opus 4.8 · US", endpoint: "runtime", scope: "US" },
  { id: "us.anthropic.claude-sonnet-5", label: "Claude Sonnet 5 · US", endpoint: "runtime", scope: "US" },
  { id: "us.anthropic.claude-sonnet-4-6", label: "Claude Sonnet 4.6 · US", endpoint: "runtime", scope: "US" },
  { id: "us.anthropic.claude-opus-4-6-v1", label: "Claude Opus 4.6 · US", endpoint: "runtime", scope: "US" },
  { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Claude Haiku 4.5 · US", endpoint: "runtime", scope: "US" },
];

function normalizedModelId(modelId: string): string {
  if (modelId === "anthropic.claude-opus-4-8") {
    return "us.anthropic.claude-opus-4-8";
  }
  return modelId;
}

const discussionVariables: PromptVariableDefinition[] = [
  { token: "{{papers}}", description: "All selected papers combined into numbered Paper 1, Paper 2, … sections." },
  { token: "{{paper_count}}", description: "The number of papers currently selected for the discussion." },
  { token: "{{paper1}}", description: "The complete context for the first selected paper." },
  { token: "{{paper2}}", description: "The complete context for the second selected paper, or “Not selected.”" },
  { token: "{{paper3}}", description: "The complete context for the third selected paper, or “Not selected.”" },
  { token: "{{paper4}}", description: "The complete context for the fourth selected paper, or “Not selected.”" },
  { token: "{{paper5}}", description: "The complete context for the fifth selected paper, or “Not selected.”" },
  { token: "{{paper6}}", description: "The complete context for the sixth selected paper, or “Not selected.”" },
  { token: "{{paper7}}", description: "The complete context for the seventh selected paper, or “Not selected.”" },
  { token: "{{paper8}}", description: "The complete context for the eighth selected paper, or “Not selected.”" },
];

const summaryVariables: PromptVariableDefinition[] = [
  { token: "{{paper}}", description: "The complete selected-paper context: metadata, abstract, and extracted source text." },
  { token: "{{paper1}}", description: "An exact alias of {{paper}} for Stacks’s numbered-paper convention." },
  { token: "{{title}}", description: "The selected paper’s title." },
  { token: "{{authors}}", description: "The selected paper’s author names, joined with commas." },
  { token: "{{venue}}", description: "The selected paper’s venue or publication source." },
  { token: "{{year}}", description: "The selected paper’s publication year." },
  { token: "{{doi}}", description: "The selected paper’s DOI, or “Not available”." },
  { token: "{{abstract}}", description: "The abstract saved in the library record." },
  { token: "{{source_text}}", description: "Full text extracted through the configured reader, or “Not available”." },
];

const extractionVariables: PromptVariableDefinition[] = [
  { token: "{{filename}}", description: "The local PDF filename being analyzed." },
  { token: "{{embedded_metadata}}", description: "Title, author, subject, and other metadata embedded in the PDF." },
  { token: "{{source_text}}", description: "Text extracted from the first pages of the PDF." },
];

function timeLabel(value: string | null): string {
  if (!value) {
    return "Never backed up in this session";
  }
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function byteLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unit);
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Request failed with ${response.status}.`;
  } catch {
    return `Request failed with ${response.status}.`;
  }
}

export function SettingsView({ notify, theme, onThemeChange, libraryName, onLibraryNameChange, papers }: {
  notify: (message: string, tone?: "success" | "error" | "info") => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  libraryName: string;
  onLibraryNameChange: (name: string) => void;
  papers: Paper[];
}) {
  const { runTask } = useBackgroundTasks();
  const [tab, setTab] = useState<SettingsTab>("appearance");
  const [settings, setSettings] = useState<SettingsSnapshot>(defaultSettings);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [checkingStorage, setCheckingStorage] = useState(false);
  const [cleaningStorage, setCleaningStorage] = useState(false);
  const [repairingStorage, setRepairingStorage] = useState(false);
  const [movingStorage, setMovingStorage] = useState(false);
  const [selectingStorageDirectory, setSelectingStorageDirectory] = useState(false);
  const [storageTarget, setStorageTarget] = useState("");
  const [storageReport, setStorageReport] = useState<StorageReport | null>(null);
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const [endpoint, setEndpoint] = useState("/api/local-settings");
  const [models, setModels] = useState<BedrockModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testingModel, setTestingModel] = useState(false);
  const [modelAccess, setModelAccess] = useState<ModelAccessResult | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [checkingVersion, setCheckingVersion] = useState(false);
  const promptEditors = useRef<Record<PromptKey, HTMLTextAreaElement | null>>({
    chatSystem: null,
    summarySystem: null,
    extractionSystem: null,
  });

  const modelOptions = models.length ? models : fallbackBedrockModels;
  const knownModel = modelOptions.some((model) => model.id === settings.ai.modelId);
  const visibleModelAccess = modelAccess?.modelId === settings.ai.modelId ? modelAccess : null;

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      let response = await fetch("/api/local-settings", { cache: "no-store" });
      let selectedEndpoint = "/api/local-settings";
      if (!response.ok) {
        response = await fetch("/api/settings", { cache: "no-store" });
        selectedEndpoint = "/api/settings";
      }
      if (!response.ok) {
        throw new Error(await errorMessage(response));
      }
      const payload = (await response.json()) as SettingsSnapshot;
      setSettings({ ...payload, ai: { ...payload.ai, modelId: normalizedModelId(payload.ai.modelId) } });
      setModelAccess(null);
      setEndpoint(selectedEndpoint);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Settings could not be loaded.", "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  const loadModels = useCallback(async (showError = false) => {
    setLoadingModels(true);
    try {
      const response = await fetch("/api/models", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(await errorMessage(response));
      }
      const payload = await response.json() as { models: BedrockModelOption[] };
      setModels(payload.models);
    } catch (error) {
      if (showError) {
        notify(error instanceof Error ? error.message : "The Bedrock catalog could not be loaded.", "error");
      }
    } finally {
      setLoadingModels(false);
    }
  }, [notify]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSettings(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSettings]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadModels(), 0);
    return () => window.clearTimeout(timer);
  }, [loadModels]);

  function updateAi<Key extends keyof SettingsSnapshot["ai"]>(key: Key, value: SettingsSnapshot["ai"][Key]) {
    setSettings((current) => ({ ...current, ai: { ...current.ai, [key]: value } }));
    setModelAccess(null);
  }

  function updateSync<Key extends keyof SettingsSnapshot["sync"]>(key: Key, value: SettingsSnapshot["sync"][Key]) {
    setSettings((current) => ({ ...current, sync: { ...current.sync, [key]: value } }));
  }

  function updatePrompt<Key extends keyof SettingsSnapshot["prompts"]>(key: Key, value: SettingsSnapshot["prompts"][Key]) {
    setSettings((current) => ({ ...current, prompts: { ...current.prompts, [key]: value } }));
  }

  function insertPromptVariable(key: PromptKey, variable: string) {
    const editor = promptEditors.current[key];
    const current = settings.prompts[key];
    const selectionStart = editor?.selectionStart ?? current.length;
    const selectionEnd = editor?.selectionEnd ?? selectionStart;
    const next = `${current.slice(0, selectionStart)}${variable}${current.slice(selectionEnd)}`;
    updatePrompt(key, next);
    window.requestAnimationFrame(() => {
      const nextEditor = promptEditors.current[key];
      const caret = selectionStart + variable.length;
      nextEditor?.focus();
      nextEditor?.setSelectionRange(caret, caret);
    });
  }

  async function testModelAccess() {
    if (!settings.ai.modelId.trim()) {
      notify("Choose a model before testing access.", "error");
      return;
    }
    setTestingModel(true);
    setModelAccess(null);
    try {
      const response = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: settings.ai.modelId }),
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response));
      }
      const result = await response.json() as ModelAccessResult;
      setModelAccess(result);
      if (result.available && result.region && result.region !== settings.ai.region) {
        updateAi("region", result.region);
      }
      notify(result.message, result.available ? "success" : "error");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Model access could not be tested.", "error");
    } finally {
      setTestingModel(false);
    }
  }

  async function chooseDirectory() {
    if (!settings.local) {
      notify(settings.sync.unavailableReason ?? "OneDrive folder sync is available only in local mode.", "info");
      return;
    }
    setSelectingDirectory(true);
    try {
      const response = await fetch("/api/local-directory-picker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "remote" }),
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response));
      }
      const payload = await response.json() as { path: string | null };
      if (payload.path) {
        updateSync("remotePath", payload.path);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "The folder selector could not be opened.", "error");
    } finally {
      setSelectingDirectory(false);
    }
  }

  async function chooseStorageDirectory() {
    if (storageReport?.capabilities?.folderMove === false) {
      notify("Moving a local library folder requires Stacks's local filesystem companion.", "info");
      return;
    }
    setSelectingStorageDirectory(true);
    try {
      const response = await fetch("/api/local-directory-picker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "storage" }),
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response));
      }
      const payload = await response.json() as { path: string | null };
      if (payload.path) {
        setStorageTarget(payload.path);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "The library destination could not be selected.", "error");
    } finally {
      setSelectingStorageDirectory(false);
    }
  }

  function settingsData() {
    return {
      modelId: settings.ai.modelId,
      region: settings.ai.region,
      maxTokens: settings.ai.maxTokens,
      temperature: settings.ai.temperature,
      pdfPages: settings.ai.pdfPages,
      chatSystemPrompt: settings.prompts.chatSystem,
      extractionSystemPrompt: settings.prompts.extractionSystem,
      summarySystemPrompt: settings.prompts.summarySystem,
      remotePath: settings.sync.remotePath,
      autoSync: settings.sync.autoSync,
      autoSyncInterval: settings.sync.autoSyncInterval,
      secrets,
    };
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    setSaving(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: settingsData() }),
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response));
      }
      const saved = (await response.json()) as SettingsSnapshot;
      setSettings(saved);
      setSecrets({});
      notify(saved.local ? "Settings saved to Stacks’s protected local settings file." : "Settings saved to Stacks’s application database.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Settings could not be saved.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function syncNow() {
    if (!settings.local || settings.sync.available === false) {
      notify(settings.sync.unavailableReason ?? "OneDrive folder sync is available only in local mode.", "info");
      return;
    }
    if (!settings.sync.remotePath.trim()) {
      notify("Choose a OneDrive backup folder first.", "error");
      return;
    }
    setSyncing(true);
    try {
      const payload = await runTask("Back up Stacks library to OneDrive", async () => {
        const response = await fetch("/api/local-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: settingsData() }),
        });
        if (!response.ok) {
          throw new Error(await errorMessage(response));
        }
        return response.json() as Promise<{ result: SyncResult; sync: SettingsSnapshot["sync"] }>;
      });
      setSettings((current) => ({ ...current, sync: payload.sync }));
      notify(payload.result.summary);
    } catch (error) {
      notify(error instanceof Error ? error.message : "OneDrive backup failed.", "error");
      await loadSettings();
    } finally {
      setSyncing(false);
    }
  }

  const checkVersion = useCallback(async () => {
    setCheckingVersion(true);
    try {
      const response = await fetch("/api/version?check=1", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(await errorMessage(response));
      }
      setVersionInfo(await response.json() as VersionInfo);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Stacks could not check for updates.", "error");
    } finally {
      setCheckingVersion(false);
    }
  }, [notify]);

  const inspectStorage = useCallback(async (showToast = false) => {
    setCheckingStorage(true);
    try {
      const response = await fetch("/api/storage-management", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "inspect",
          papers: papers.map((paper) => ({
            id: paper.id,
            localPath: paper.localPath,
            htmlSnapshotPath: paper.htmlSnapshotPath,
          })),
        }),
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response));
      }
      const report = await response.json() as StorageReport;
      setStorageReport(report);
      if (showToast) {
        notify(`Doctor checked ${report.paperRecords} papers and ${report.totalFiles} managed files.`, report.missingPdfFiles || report.missingHtmlFiles || report.invalidReferences ? "info" : "success");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "Library Doctor could not inspect Stacks storage.", "error");
    } finally {
      setCheckingStorage(false);
    }
  }, [notify, papers]);

  async function cleanStorage() {
    if (!storageReport?.orphanedFiles) {
      notify("Doctor did not find any unlinked Stacks-managed assets.", "info");
      return;
    }
    const summary = `${storageReport.orphanedFiles} unlinked file${storageReport.orphanedFiles === 1 ? "" : "s"} (${byteLabel(storageReport.orphanedBytes)})`;
    if (!window.confirm(`Remove ${summary} from the active Stacks library? Referenced files will not be touched.`)) {
      return;
    }
    if (!window.confirm(`Final confirmation: permanently delete ${summary}? This cannot be undone.`)) {
      return;
    }
    setCleaningStorage(true);
    try {
      const response = await fetch("/api/storage-management", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "clean",
          confirmed: true,
          papers: papers.map((paper) => ({
            id: paper.id,
            localPath: paper.localPath,
            htmlSnapshotPath: paper.htmlSnapshotPath,
          })),
        }),
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response));
      }
      const report = await response.json() as StorageReport;
      notify(`Removed ${report.removedFiles} unlinked file${report.removedFiles === 1 ? "" : "s"} and reclaimed ${byteLabel(report.removedBytes)}.`, "success");
      await inspectStorage(false);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unlinked assets could not be removed.", "error");
    } finally {
      setCleaningStorage(false);
    }
  }

  async function repairStorage() {
    const description = "remove orphaned association rows, delete authors, venues, and collections left with no papers, and delete unlinked files from the managed pdfs/ and html_snapshots/ folders";
    if (!window.confirm(`Repair Stacks now? Doctor will ${description}. Missing or ambiguous files will be left unchanged.`)) {
      return;
    }
    if (!window.confirm("Final confirmation: apply these database and managed-file repairs?")) {
      return;
    }
    setRepairingStorage(true);
    try {
      const report = await runTask("Repair Stacks library", async () => {
        const response = await fetch("/api/storage-management", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "repair",
            confirmed: true,
            papers: papers.map((paper) => ({
              id: paper.id,
              localPath: paper.localPath,
              htmlSnapshotPath: paper.htmlSnapshotPath,
            })),
          }),
        });
        if (!response.ok) {
          throw new Error(await errorMessage(response));
        }
        return response.json() as Promise<StorageReport>;
      });
      setStorageReport(report);
      const summary = report.databaseHealth?.repairSummary;
      notify(summary
        ? `Repair complete: ${summary.orphanedAssociations} associations removed, ${summary.portablePaths} paths fixed, ${summary.renamedPdfs} PDFs renamed, and ${summary.migratedLegacyFiles ?? 0} legacy files copied into this library.`
        : "Database repair completed.", "success");
      if (summary && (summary.portablePaths || summary.renamedPdfs)) {
        window.setTimeout(() => window.location.reload(), 900);
      } else {
        await inspectStorage(false);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "Stacks could not complete the repair.", "error");
    } finally {
      setRepairingStorage(false);
    }
  }

  async function moveLibrary() {
    const targetPath = storageTarget.trim();
    if (!targetPath) {
      notify("Choose a destination for the Stacks library first.", "info");
      return;
    }
    const sourcePath = storageReport?.libraryRoot ?? "the active Stacks library";
    if (!window.confirm(`Move the complete Stacks library from ${sourcePath} to ${targetPath}?`)) {
      return;
    }
    if (!window.confirm("Final confirmation: copy Stacks’s managed PDFs and HTML snapshots to the new location, switch local file storage to it, and remove the old managed-file folder?")) {
      return;
    }
    setMovingStorage(true);
    try {
      const response = await fetch("/api/storage-management", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "move",
          targetDirectory: targetPath,
          confirmed: true,
          papers: papers.map((paper) => ({
            id: paper.id,
            localPath: paper.localPath,
            htmlSnapshotPath: paper.htmlSnapshotPath,
          })),
        }),
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response));
      }
      const report = await response.json() as StorageReport;
      setStorageReport(report);
      setStorageTarget("");
      notify(`Stacks now uses ${report.libraryRoot}.`, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The Stacks library could not be moved.", "error");
    } finally {
      setMovingStorage(false);
    }
  }

  useEffect(() => {
    if (tab !== "storage" || storageReport || checkingStorage) {
      return;
    }
    const timer = window.setTimeout(() => void inspectStorage(false), 0);
    return () => window.clearTimeout(timer);
  }, [checkingStorage, inspectStorage, storageReport, tab]);

  useEffect(() => {
    if (tab !== "about" || versionInfo || checkingVersion) {
      return;
    }
    const timer = window.setTimeout(() => void checkVersion(), 0);
    return () => window.clearTimeout(timer);
  }, [checkVersion, checkingVersion, tab, versionInfo]);

  return (
    <div className="settings-layout">
      <aside className="settings-nav" aria-label="Settings sections">
        <p>Configuration</p>
        <TabButton variant="nav" active={tab === "appearance"} onClick={() => setTab("appearance")} icon={<Palette />}><span><strong>Appearance</strong><small>Library name and theme</small></span></TabButton>
        <TabButton variant="nav" active={tab === "model"} onClick={() => setTab("model")} icon={<Bot />}><span><strong>AI model</strong><small>Bedrock and generation</small></span></TabButton>
        <TabButton variant="nav" active={tab === "prompts"} onClick={() => setTab("prompts")} icon={<MessageSquareText />}><span><strong>Prompt templates</strong><small>Discussion, summaries, extraction</small></span></TabButton>
        <TabButton variant="nav" active={tab === "storage"} onClick={() => setTab("storage")} icon={<HardDrive />}><span><strong>Storage &amp; Doctor</strong><small>Location, health, and cleanup</small></span></TabButton>
        <TabButton variant="nav" active={tab === "sync"} onClick={() => setTab("sync")} icon={<CloudCog />}><span><strong>OneDrive sync</strong><small>Remote library backup</small></span></TabButton>
        <TabButton variant="nav" active={tab === "integrations"} onClick={() => setTab("integrations")} icon={<KeyRound />}><span><strong>Integrations</strong><small>Discovery and extraction</small></span></TabButton>
        <TabButton variant="nav" active={tab === "about"} onClick={() => setTab("about")} icon={<Info />}><span><strong>About &amp; updates</strong><small>Version and release status</small></span></TabButton>
        <div className="settings-local-note"><ShieldCheck size={16} /><span><strong>Stored locally</strong><small>Settings and secrets live in the library folder&rsquo;s settings.json; keys are never displayed after saving.</small></span></div>
      </aside>

      <div className="settings-content">
        {loading ? <div className="settings-loading"><LoaderCircle className="spin" size={22} /><span>Reading environment…</span></div> : null}

        {!loading && tab === "appearance" ? (
          <section>
            <SettingsHeading icon={<Palette size={19} />} title="Appearance" detail="Personalize this browser without changing Stacks’s source database." />
            <div className="settings-card">
              <div className="settings-form-grid">
                <label className="span-2"><span>Library name</span><input value={libraryName} maxLength={60} onChange={(event) => onLibraryNameChange(event.target.value)} placeholder="My Paper Library" /><small>Shown in the lower-left library status. The product name remains Stacks.</small></label>
                <div className="theme-choice-field span-2"><span>Color theme</span><div className="theme-choice-grid"><SelectCard selected={theme === "dark"} onClick={() => onThemeChange("dark")} icon={<Moon />} title="Dark" description="Low-glare research workspace" trailing={theme === "dark" ? <Check /> : null} /><SelectCard selected={theme === "light"} onClick={() => onThemeChange("light")} icon={<Sun />} title="Light" description="Bright, paper-like workspace" trailing={theme === "light" ? <Check /> : null} /></div><small>Appearance is saved automatically in this browser.</small></div>
              </div>
            </div>
          </section>
        ) : null}

        {!loading && tab === "model" ? (
          <form onSubmit={save}>
            <SettingsHeading icon={<Bot size={19} />} title="AI model" detail="Choose an available Amazon Bedrock inference profile." />
            <div className="settings-card">
              <div className="settings-card-title"><span><Cloud size={16} /></span><div><strong>Amazon Bedrock</strong><small>API key authentication · Runtime Converse</small></div><i className="connected-pill"><Check size={11} /> Active</i></div>
              <div className="settings-form-grid">
                <label className="span-2"><span>Model</span><select value={knownModel ? settings.ai.modelId : "custom"} onChange={(event) => updateAi("modelId", event.target.value === "custom" ? "" : event.target.value)}>{modelOptions.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}<option value="custom">Custom Bedrock model ID…</option></select><small>{models.length ? `${models.length} active Anthropic inference profiles loaded from Bedrock.` : "Using the built-in model fallback while the Bedrock catalog loads."}</small></label>
                {!knownModel ? <label className="span-2"><span>Custom model ID</span><input value={settings.ai.modelId} onChange={(event) => updateAi("modelId", event.target.value)} placeholder="anthropic.model or us.provider.model-id" required /><small>Base Anthropic IDs use Bedrock Mantle; geo, global, and inference-profile IDs use Bedrock Runtime.</small></label> : null}
                <div className="model-access-row span-2"><span className={visibleModelAccess ? visibleModelAccess.available ? "is-available" : "is-unavailable" : ""}>{visibleModelAccess ? visibleModelAccess.message : "Catalog presence does not guarantee that this API key can invoke the selected model. Use Test access to verify it."}</span><ActionButton variant="secondary" size="small" onClick={() => void loadModels(true)} disabled={loadingModels} icon={loadingModels ? <LoaderCircle className="spin" /> : <RefreshCw />}>Refresh models</ActionButton><ActionButton variant="secondary" size="small" onClick={() => void testModelAccess()} disabled={testingModel || !settings.ai.modelId.trim()} icon={testingModel ? <LoaderCircle className="spin" /> : <Check />}>Test access</ActionButton></div>
                <label><span>AWS region</span><select value={settings.ai.region} onChange={(event) => updateAi("region", event.target.value)}><option value="us-east-1">US East (N. Virginia) · us-east-1</option><option value="us-east-2">US East (Ohio) · us-east-2</option><option value="us-west-2">US West (Oregon) · us-west-2</option><option value="eu-west-1">Europe (Ireland) · eu-west-1</option><option value="eu-central-1">Europe (Frankfurt) · eu-central-1</option><option value="ap-northeast-1">Asia Pacific (Tokyo) · ap-northeast-1</option><option value="ap-southeast-1">Asia Pacific (Singapore) · ap-southeast-1</option><option value="ap-southeast-2">Asia Pacific (Sydney) · ap-southeast-2</option></select></label>
                <label><span>Maximum output tokens</span><input type="number" min="128" step="1" value={settings.ai.maxTokens} onChange={(event) => updateAi("maxTokens", Number(event.target.value))} /><small>Stacks sends this value to the selected model without imposing an artificial upper limit; the model’s own output limit still applies.</small></label>
                <label><span>PDF grounding pages</span><input type="number" min="1" max="20" step="1" value={settings.ai.pdfPages} onChange={(event) => updateAi("pdfPages", Number(event.target.value))} /><small>Ask Stacks extracts this many opening pages from each attached PDF, up to a safe 20-page limit.</small></label>
                <label className="span-2"><span>Temperature <b>{settings.ai.temperature.toFixed(2)}</b></span><input className="range-input" type="range" min="0" max="1" step="0.05" value={settings.ai.temperature} onChange={(event) => updateAi("temperature", Number(event.target.value))} disabled={settings.ai.modelId.includes("claude-opus-4-8")} /><small>{settings.ai.modelId.includes("claude-opus-4-8") ? "Opus 4.8 manages sampling automatically, so Bedrock does not accept a temperature value." : "Lower values keep research answers more consistent and restrained."}</small></label>
              </div>
            </div>
            <SettingsFooter saving={saving} onRefresh={() => void loadSettings()} />
          </form>
        ) : null}

        {!loading && tab === "prompts" ? (
          <form onSubmit={save}>
            <SettingsHeading icon={<MessageSquareText size={19} />} title="Prompt templates" detail="Shape discussion, summary, and PDF metadata extraction." />
            <div className="settings-card prompt-settings-card">
              <details className="prompt-template-section">
                <summary><span><strong>Discussion system prompt</strong><small>Ask Stacks with up to eight selected papers.</small></span><ChevronDown size={16} /></summary>
                <div className="prompt-template-content"><PromptEditor inputRef={promptEditors} promptKey="chatSystem" value={settings.prompts.chatSystem} onChange={(value) => updatePrompt("chatSystem", value)} /><small>Stacks numbers discussion context as Paper 1, Paper 2, and so on. Insert a placeholder wherever that context should appear.</small><PromptVariables variables={discussionVariables} onInsert={(variable) => insertPromptVariable("chatSystem", variable)} /><ActionButton variant="secondary" size="small" className="mt-0.5 justify-self-start" onClick={() => updatePrompt("chatSystem", DEFAULT_CHAT_SYSTEM_PROMPT)}>Restore discussion default</ActionButton></div>
              </details>
              <details className="prompt-template-section">
                <summary><span><strong>Summary system prompt</strong><small>Create the reusable Stacks summary stored with a paper.</small></span><ChevronDown size={16} /></summary>
                <div className="prompt-template-content"><PromptEditor inputRef={promptEditors} promptKey="summarySystem" value={settings.prompts.summarySystem} onChange={(value) => updatePrompt("summarySystem", value)} /><small>Summary placeholders are replaced with the selected paper’s current metadata and extracted content.</small><PromptVariables variables={summaryVariables} onInsert={(variable) => insertPromptVariable("summarySystem", variable)} /><ActionButton variant="secondary" size="small" className="mt-0.5 justify-self-start" onClick={() => updatePrompt("summarySystem", DEFAULT_SUMMARY_SYSTEM_PROMPT)}>Restore summary default</ActionButton></div>
              </details>
              <details className="prompt-template-section">
                <summary><span><strong>PDF extraction system prompt</strong><small>Extract structured metadata from local PDF text.</small></span><ChevronDown size={16} /></summary>
                <div className="prompt-template-content"><PromptEditor inputRef={promptEditors} promptKey="extractionSystem" value={settings.prompts.extractionSystem} onChange={(value) => updatePrompt("extractionSystem", value)} /><small>Extraction analyzes embedded PDF metadata and the first pages, then returns normalized paper fields.</small><PromptVariables variables={extractionVariables} onInsert={(variable) => insertPromptVariable("extractionSystem", variable)} /><ActionButton variant="secondary" size="small" className="mt-0.5 justify-self-start" onClick={() => updatePrompt("extractionSystem", DEFAULT_EXTRACTION_SYSTEM_PROMPT)}>Restore extraction default</ActionButton></div>
              </details>
            </div>
            <SettingsFooter saving={saving} onRefresh={() => void loadSettings()} />
          </form>
        ) : null}

        {!loading && tab === "storage" ? (
          <section className="settings-storage-section">
            <SettingsHeading icon={<HardDrive size={19} />} title="Storage & Doctor" detail="Manage Stacks’s independent library location and verify every local asset." />
            <div className="settings-card storage-location-card">
              <div className="storage-location-heading">
                <span className="storage-doctor-icon"><HardDrive size={18} /></span>
                <div><strong>Stacks library location</strong><small>The library.db database, settings, and managed PDFs and HTML snapshots all live in this folder.</small></div>
              </div>
              <div className="storage-root-summary">
                <span>Active library</span>
                <code>{storageReport?.libraryRoot ?? "Inspecting…"}</code>
                <small>{storageReport?.libraryExists ? "Folder available" : "Folder has not been created yet"}</small>
              </div>
              <label className="storage-move-field">
                <span>Move library to</span>
                <div className="path-picker-control">
                  <input disabled={storageReport?.capabilities?.folderMove === false} value={storageTarget} onChange={(event) => setStorageTarget(event.target.value)} placeholder="/Users/…/Stacks" />
                  <ActionButton variant="secondary" onClick={() => void chooseStorageDirectory()} disabled={storageReport?.capabilities?.folderMove === false || selectingStorageDirectory || movingStorage} icon={selectingStorageDirectory ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}>Browse</ActionButton>
                  <ActionButton variant="secondary" onClick={() => void moveLibrary()} disabled={storageReport?.capabilities?.folderMove === false || movingStorage || !storageTarget.trim()} icon={movingStorage ? <LoaderCircle className="spin" size={15} /> : <ArrowRightLeft size={15} />}>Move</ActionButton>
                </div>
                <small>Moves Stacks-managed files, switches local file storage to the new location, and removes the old managed-file folder only after two confirmations.</small>
              </label>
            </div>
            <div className="settings-card storage-doctor-card">
              <div className="storage-doctor-heading">
                <span className="storage-doctor-icon"><ScanSearch size={18} /></span>
                <div><strong>Library Doctor</strong><small>Checks database records against PDFs, HTML snapshots, invalid paths, and unlinked Stacks-managed assets.</small></div>
                <ActionButton variant="secondary" onClick={() => void inspectStorage(true)} disabled={checkingStorage} icon={checkingStorage ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}>Check now</ActionButton>
              </div>
              {storageReport ? (
                <>
                  <div className="storage-doctor-grid">
                    <DoctorMetric icon={<DatabaseBackup size={17} />} label="Library database" value={storageReport.databaseHealth ? storageReport.databaseHealth.integrityOk && !storageReport.databaseHealth.foreignKeyViolations ? "Healthy" : "Needs attention" : storageReport.databasePresent ? "Available" : "Missing"} detail={`${storageReport.paperRecords} papers · ${storageReport.databaseHealth?.foreignKeyViolations ?? 0} FK violations`} tone={storageReport.databaseHealth ? storageReport.databaseHealth.integrityOk && !storageReport.databaseHealth.foreignKeyViolations ? "good" : "bad" : storageReport.databasePresent ? "good" : "bad"} />
                    <DoctorMetric icon={<DatabaseBackup size={17} />} label="Associations" value={`${storageReport.databaseHealth ? Object.values(storageReport.databaseHealth.orphanedAssociations).reduce((sum, count) => sum + count, 0) : 0} orphaned`} detail={storageReport.databaseHealth?.foreignKeyEnforced ? "Foreign keys are enforced" : "Foreign-key enforcement unavailable"} tone={storageReport.databaseHealth && (storageReport.databaseHealth.foreignKeyViolations || Object.values(storageReport.databaseHealth.orphanedAssociations).some(Boolean)) ? "bad" : "good"} />
                    {storageReport.databaseHealth?.orphanedEntities ? (() => {
                      const entities = storageReport.databaseHealth.orphanedEntities;
                      const total = entities.authors + entities.venues + entities.collections;
                      return <DoctorMetric icon={<Users size={17} />} label="Orphaned records" value={`${total} orphaned`} detail={`${entities.authors} authors · ${entities.venues} venues · ${entities.collections} collections with no papers`} tone={total ? "warn" : "good"} />;
                    })() : null}
                    <DoctorMetric icon={<HardDrive size={17} />} label="PDFs" value={storageReport.capabilities?.fileChecks === false ? `${storageReport.referencedPdfFiles} referenced` : `${storageReport.presentPdfFiles}/${storageReport.referencedPdfFiles} linked`} detail={storageReport.capabilities?.fileChecks === false ? "Physical-file checks require local mode" : `${storageReport.missingPdfFiles} missing · ${storageReport.storedPdfFiles} physical files · ${byteLabel(storageReport.storedPdfBytes)}`} tone={storageReport.missingPdfFiles ? "bad" : "good"} />
                    <DoctorMetric icon={<HardDrive size={17} />} label="HTML snapshots" value={storageReport.capabilities?.fileChecks === false ? `${storageReport.referencedHtmlFiles} referenced` : `${storageReport.presentHtmlFiles}/${storageReport.referencedHtmlFiles} linked`} detail={storageReport.capabilities?.fileChecks === false ? "Physical-file checks require local mode" : `${storageReport.missingHtmlFiles} missing · ${storageReport.storedHtmlFiles} physical files · ${byteLabel(storageReport.storedHtmlBytes)}`} tone={storageReport.missingHtmlFiles ? "bad" : "good"} />
                    <DoctorMetric icon={<FileWarning size={17} />} label="No local source" value={`${storageReport.papersWithoutLocalAsset} papers`} detail="Neither a readable PDF nor HTML snapshot was found" tone={storageReport.papersWithoutLocalAsset ? "warn" : "good"} />
                    <DoctorMetric icon={<FileWarning size={17} />} label="Invalid references" value={`${storageReport.invalidReferences} paths`} detail="Stored paths that do not satisfy Stacks’s portable-path rules" tone={storageReport.invalidReferences ? "bad" : "good"} />
                    <DoctorMetric icon={<Trash2 size={17} />} label="Unlinked assets" value={`${storageReport.orphanedFiles} files`} detail={`${byteLabel(storageReport.orphanedBytes)} reclaimable · ${byteLabel(storageReport.totalBytes)} managed total`} tone={storageReport.orphanedFiles ? "warn" : "good"} />
                    {storageReport.systemHealth ? (
                      <>
                        <DoctorMetric icon={<Cpu size={17} />} label="Runtime" value={storageReport.systemHealth.runtime} detail={storageReport.systemHealth.platform ?? "Local server"} tone="good" />
                        <DoctorMetric icon={<DatabaseBackup size={17} />} label="Database engine" value={storageReport.systemHealth.database} detail="Local SQLite file — no external database" tone="good" />
                        <DoctorMetric icon={<Bot size={17} />} label="Claude CLI (AI feed)" value={storageReport.systemHealth.claudeCli ?? "Not found"} detail={storageReport.systemHealth.claudeCli ? "Available for headless feed agents" : "Install the claude CLI to use the AI feed"} tone={storageReport.systemHealth.claudeCli ? "good" : "warn"} />
                      </>
                    ) : null}
                  </div>
                  <DoctorPaths label="Missing PDF references" paths={storageReport.missingPdfPaths} />
                  <DoctorPaths label="Missing HTML references" paths={storageReport.missingHtmlPaths} />
                  <DoctorPaths label="Invalid PDF paths" paths={storageReport.invalidPdfPaths} />
                  <DoctorPaths label="Invalid HTML paths" paths={storageReport.invalidHtmlPaths} />
                  <div className="storage-doctor-actions">
                    <p>Cleanup deletes only unlinked files from Stacks’s managed pdfs/ and html_snapshots/ folders. It requires two confirmations and never deletes linked assets.</p>
                    <div className="storage-doctor-action-buttons">
                      <ActionButton variant="secondary" onClick={() => void repairStorage()} disabled={repairingStorage || !storageReport.capabilities?.repairs.length} icon={repairingStorage ? <LoaderCircle className="spin" size={15} /> : <Wrench size={15} />}>{storageReport.mode === "hosted" ? "Repair database" : "Repair library"}</ActionButton>
                      <ActionButton variant="danger" onClick={() => void cleanStorage()} disabled={cleaningStorage || !storageReport.orphanedFiles} icon={cleaningStorage ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}>Clean unlinked assets</ActionButton>
                    </div>
                  </div>
                </>
              ) : <div className="storage-doctor-loading"><LoaderCircle className="spin" size={18} /><span>Inspecting Stacks storage…</span></div>}
            </div>
          </section>
        ) : null}

        {!loading && tab === "sync" ? (
          <form onSubmit={save}>
            <SettingsHeading icon={<DatabaseBackup size={19} />} title="OneDrive sync" detail="Back up Stacks’s library database, PDFs, and HTML snapshots." />
            <div className="sync-status-card">
              <span className={`sync-status-icon ${settings.sync.lastResult?.ok ? "is-success" : ""}`}><FolderSync size={20} /></span>
              <div><strong>{settings.sync.lastResult?.summary ?? (settings.local ? "Ready to connect OneDrive" : "Local companion required")}</strong><small>{settings.local ? timeLabel(settings.sync.lastSyncAt) : settings.sync.unavailableReason}</small></div>
              <ActionButton variant="primary" onClick={() => void syncNow()} disabled={syncing || !settings.local || !settings.sync.sourceExists || !settings.sync.remotePath.trim()} title={!settings.local ? settings.sync.unavailableReason : !settings.sync.sourceExists ? "Stacks’s local library database is not available" : !settings.sync.remotePath.trim() ? "Choose a OneDrive folder first" : "Back up Stacks now"} icon={syncing ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}>{syncing ? "Backing up…" : "Back up now"}</ActionButton>
            </div>
            <div className="settings-card">
              <div className="settings-form-grid">
                <label className="span-2"><span>OneDrive backup folder</span><div className="path-picker-control"><input disabled={!settings.local} list="onedrive-paths" value={settings.sync.remotePath} onChange={(event) => updateSync("remotePath", event.target.value)} placeholder="~/Library/CloudStorage/OneDrive-…/Stacks-Backup" /><ActionButton variant="secondary" onClick={() => void chooseDirectory()} disabled={!settings.local || selectingDirectory} icon={selectingDirectory ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}>Choose</ActionButton></div><datalist id="onedrive-paths">{settings.sync.detectedPaths.map((path) => <option value={`${path}/Stacks-Backup`} key={path} />)}</datalist><small>{settings.local ? "Stacks writes a consistent library.db backup plus pdfs/ and html_snapshots/ here, creating the folder if needed. Existing contents are kept — backup only adds, never deletes. Must be outside the live library folder." : "A hosted Worker cannot access a folder on this computer. Run Stacks locally to enable backups."}</small></label>
                <label><span>Auto-sync interval</span><div className="unit-input"><input disabled={!settings.local} type="number" min="5" max="3600" value={settings.sync.autoSyncInterval} onChange={(event) => updateSync("autoSyncInterval", Number(event.target.value))} /><i>seconds</i></div></label>
              </div>
              <label className="settings-toggle"><input disabled={!settings.local} type="checkbox" checked={settings.sync.autoSync} onChange={(event) => updateSync("autoSync", event.target.checked)} /><span /><div><strong>Auto-back up after live Stacks changes</strong><small>Writes a fresh one-way backup to OneDrive in the background.</small></div></label>
              <div className="sync-caution"><ShieldCheck size={16} /><p><strong>The local library is authoritative.</strong> Backup writes a consistent one-way copy to OneDrive; it never reads the OneDrive copy back onto the live library. Restoring a backup is a manual step.</p></div>
            </div>
            <SettingsFooter saving={saving} onRefresh={() => void loadSettings()} />
          </form>
        ) : null}

        {!loading && tab === "integrations" ? (
          <form onSubmit={save}>
            <SettingsHeading icon={<KeyRound size={19} />} title="Integrations" detail="See what is connected and replace a key without exposing its current value." />
            <div className="integration-list">
              {secretFields.map((field) => {
                const configured = Boolean(settings.integrations[field.key]);
                return <div className="integration-row" key={field.key}><span className="integration-icon"><KeyRound size={16} /></span><div className="integration-name"><strong>{field.label}</strong><small>{field.detail}</small></div><span className={`integration-state ${configured ? "is-connected" : ""}`}>{configured ? <><Check size={11} /> Connected</> : "Not set"}</span><input type="password" value={secrets[field.key] ?? ""} onChange={(event) => setSecrets((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={configured ? "Paste to replace current key" : "Paste API key"} autoComplete="new-password" /></div>;
              })}
            </div>
            <SettingsFooter saving={saving} onRefresh={() => void loadSettings()} />
          </form>
        ) : null}

        {!loading && tab === "about" ? (
          <section>
            <SettingsHeading icon={<Info size={19} />} title="About & updates" detail="See the running version and check official GitHub releases." />
            <div className="settings-card version-status-card">
              <div>
                <span>Installed version</span>
                <strong>{versionInfo?.currentVersion ? `Stacks ${versionInfo.currentVersion}` : "Stacks"}</strong>
                <small>{versionInfo?.message ?? "Checking release status…"}</small>
              </div>
              <span className={`version-status-pill ${versionInfo?.updateAvailable ? "is-update" : ""}`}>{versionInfo?.updateAvailable ? "Update available" : versionInfo?.checked ? "Current" : "Checking"}</span>
              <div className="version-status-actions">
                <ActionButton variant="secondary" onClick={() => void checkVersion()} disabled={checkingVersion} icon={checkingVersion ? <LoaderCircle className="spin" /> : <RefreshCw />}>{checkingVersion ? "Checking…" : "Check again"}</ActionButton>
                {versionInfo?.releaseUrl ? <ActionLink variant="primary" href={versionInfo.releaseUrl} target="_blank" rel="noreferrer">View release</ActionLink> : null}
              </div>
            </div>
            <p className="version-update-note">Local installs update from the Git repository, followed by <code>npm install</code>. Hosted installs update when the latest commit is redeployed; Stacks never modifies its own source tree automatically.</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function SettingsHeading({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="settings-heading"><span>{icon}</span><div><h2>{title}</h2><p>{detail}</p></div></div>;
}

function DoctorMetric({ icon, label, value, detail, tone }: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: "good" | "warn" | "bad";
}) {
  return <div className={`storage-doctor-metric is-${tone}`}><span>{icon}</span><div><small>{label}</small><strong>{value}</strong><p>{detail}</p></div></div>;
}

function DoctorPaths({ label, paths }: { label: string; paths: string[] }) {
  if (!paths.length) {
    return null;
  }
  return <details className="storage-doctor-paths"><summary>{label} <span>{paths.length}</span></summary><ul>{paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></details>;
}

function PromptEditor({ inputRef, promptKey, value, onChange }: {
  inputRef: RefObject<Record<PromptKey, HTMLTextAreaElement | null>>;
  promptKey: PromptKey;
  value: string;
  onChange: (value: string) => void;
}) {
  const highlightLayer = useRef<HTMLPreElement | null>(null);
  const parts = value.split(/(\{\{[a-zA-Z0-9_]+\}\}|^#{1,6}\s.+$|`[^`\n]+`)/gm);

  return (
    <div className="prompt-code-editor">
      <pre ref={highlightLayer} aria-hidden="true">
        {parts.map((part, index) => {
          const className = /^\{\{.+\}\}$/.test(part)
            ? "is-variable"
            : /^#{1,6}\s/.test(part)
              ? "is-heading"
              : /^`.+`$/.test(part)
                ? "is-code"
                : undefined;
          return <span className={className} key={`${index}-${part.slice(0, 12)}`}>{part}</span>;
        })}
        {value.endsWith("\n") ? "\n" : null}
      </pre>
      <textarea
        ref={(node) => { inputRef.current[promptKey] = node; }}
        rows={8}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (!highlightLayer.current) {
            return;
          }
          highlightLayer.current.scrollTop = event.currentTarget.scrollTop;
          highlightLayer.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        spellCheck={false}
        aria-label={`${promptKey === "chatSystem" ? "Discussion" : promptKey === "summarySystem" ? "Summary" : "PDF extraction"} system prompt`}
      />
    </div>
  );
}

function PromptVariables({ variables, onInsert }: { variables: PromptVariableDefinition[]; onInsert: (variable: string) => void }) {
  return (
    <div className="prompt-variable-help">
      <div className="prompt-variable-list">
        <span>Insert placeholder</span>
        {variables.map((variable) => <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onInsert(variable.token)} title={variable.description} aria-label={`Insert ${variable.token}: ${variable.description}`} key={variable.token}>{variable.token}</button>)}
      </div>
      <details className="prompt-variable-reference">
        <summary>What each placeholder inserts</summary>
        <div>{variables.map((variable) => <p key={variable.token}><code>{variable.token}</code><span>{variable.description}</span></p>)}</div>
      </details>
    </div>
  );
}

function SettingsFooter({ saving, onRefresh }: { saving: boolean; onRefresh: () => void }) {
  return <div className="settings-footer"><ActionButton variant="secondary" onClick={onRefresh} icon={<RefreshCw size={14} />}>Reset</ActionButton><ActionButton type="submit" variant="primary" disabled={saving} icon={saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}>{saving ? "Saving…" : "Save settings"}</ActionButton></div>;
}
