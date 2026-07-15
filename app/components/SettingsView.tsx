"use client";

import {
  Bot,
  Check,
  Cloud,
  CloudCog,
  ChevronDown,
  DatabaseBackup,
  FolderOpen,
  FolderSync,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  Moon,
  Palette,
  RefreshCw,
  Save,
  ShieldCheck,
  Sun,
} from "lucide-react";
import type { FormEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_EXTRACTION_SYSTEM_PROMPT,
  DEFAULT_SUMMARY_SYSTEM_PROMPT,
} from "@/app/lib/ai-prompts";
import { useBackgroundTasks } from "@/app/components/BackgroundTasks";

type SettingsTab = "appearance" | "model" | "prompts" | "sync" | "integrations";
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
  },
};

const secretFields = [
  { key: "AWS_BEARER_TOKEN_BEDROCK", label: "AWS Bedrock API key", detail: "Chat and on-demand summaries" },
  { key: "SEMANTIC_SCHOLAR_API_KEY", label: "Semantic Scholar", detail: "Academic discovery and metadata" },
  { key: "SERPAPI_KEY", label: "SerpAPI", detail: "Google Scholar discovery" },
  { key: "JINA_API_KEY", label: "Jina Reader", detail: "Clean web and paper extraction" },
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
  { token: "{{paper1}}", description: "An exact alias of {{paper}} for PA’s numbered-paper convention." },
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
    return "Never synced in this session";
  }
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Request failed with ${response.status}.`;
  } catch {
    return `Request failed with ${response.status}.`;
  }
}

export function SettingsView({ notify, theme, onThemeChange, libraryName, onLibraryNameChange }: {
  notify: (message: string, tone?: "success" | "error" | "info") => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  libraryName: string;
  onLibraryNameChange: (name: string) => void;
}) {
  const { runTask } = useBackgroundTasks();
  const [tab, setTab] = useState<SettingsTab>("appearance");
  const [settings, setSettings] = useState<SettingsSnapshot>(defaultSettings);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const [endpoint, setEndpoint] = useState("/api/local-settings");
  const [models, setModels] = useState<BedrockModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testingModel, setTestingModel] = useState(false);
  const [modelAccess, setModelAccess] = useState<ModelAccessResult | null>(null);
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

  function settingsData() {
    return {
      modelId: settings.ai.modelId,
      region: settings.ai.region,
      maxTokens: settings.ai.maxTokens,
      temperature: settings.ai.temperature,
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
      setSettings((await response.json()) as SettingsSnapshot);
      setSecrets({});
      notify("Settings saved to PA’s protected local settings file.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Settings could not be saved.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function syncNow() {
    if (!settings.sync.remotePath.trim()) {
      notify("Choose a OneDrive directory before syncing.", "error");
      return;
    }
    setSyncing(true);
    try {
      const payload = await runTask("Sync PA library to OneDrive", async () => {
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
      notify(error instanceof Error ? error.message : "OneDrive sync failed.", "error");
      await loadSettings();
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="settings-layout">
      <aside className="settings-nav" aria-label="Settings sections">
        <p>Configuration</p>
        <button className={tab === "appearance" ? "is-active" : ""} onClick={() => setTab("appearance")}><Palette size={16} /><span><strong>Appearance</strong><small>Library name and theme</small></span></button>
        <button className={tab === "model" ? "is-active" : ""} onClick={() => setTab("model")}><Bot size={16} /><span><strong>AI model</strong><small>Bedrock and generation</small></span></button>
        <button className={tab === "prompts" ? "is-active" : ""} onClick={() => setTab("prompts")}><MessageSquareText size={16} /><span><strong>Prompt templates</strong><small>Discussion, summaries, extraction</small></span></button>
        <button className={tab === "sync" ? "is-active" : ""} onClick={() => setTab("sync")}><CloudCog size={16} /><span><strong>OneDrive sync</strong><small>Library backup and local files</small></span></button>
        <button className={tab === "integrations" ? "is-active" : ""} onClick={() => setTab("integrations")}><KeyRound size={16} /><span><strong>Integrations</strong><small>Discovery and extraction</small></span></button>
        <div className="settings-local-note"><ShieldCheck size={16} /><span><strong>{settings.local ? "Stored locally" : "Deployment managed"}</strong><small>{settings.local ? "Protected structured file; secrets are never displayed" : "Use deployment environment variables"}</small></span></div>
      </aside>

      <div className="settings-content">
        {loading ? <div className="settings-loading"><LoaderCircle className="spin" size={22} /><span>Reading environment…</span></div> : null}

        {!loading && tab === "appearance" ? (
          <section>
            <SettingsHeading icon={<Palette size={19} />} title="Appearance" detail="Personalize this browser without changing PA’s source database." />
            <div className="settings-card">
              <div className="settings-form-grid">
                <label className="span-2"><span>Library name</span><input value={libraryName} maxLength={60} onChange={(event) => onLibraryNameChange(event.target.value)} placeholder="My Paper Library" /><small>Shown in the lower-left library status. The product name remains Paper Assistant.</small></label>
                <div className="theme-choice-field span-2"><span>Color theme</span><div className="theme-choice-grid"><button type="button" className={theme === "dark" ? "is-active" : ""} onClick={() => onThemeChange("dark")}><Moon size={18} /><span><strong>Dark</strong><small>Low-glare research workspace</small></span>{theme === "dark" ? <Check size={15} /> : null}</button><button type="button" className={theme === "light" ? "is-active" : ""} onClick={() => onThemeChange("light")}><Sun size={18} /><span><strong>Light</strong><small>Bright, paper-like workspace</small></span>{theme === "light" ? <Check size={15} /> : null}</button></div><small>Appearance is saved automatically in this browser.</small></div>
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
                <div className="model-access-row span-2"><span className={visibleModelAccess ? visibleModelAccess.available ? "is-available" : "is-unavailable" : ""}>{visibleModelAccess ? visibleModelAccess.message : "Catalog presence does not guarantee that this API key can invoke the selected model. Use Test access to verify it."}</span><button type="button" onClick={() => void loadModels(true)} disabled={loadingModels}>{loadingModels ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} Refresh models</button><button type="button" onClick={() => void testModelAccess()} disabled={testingModel || !settings.ai.modelId.trim()}>{testingModel ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />} Test access</button></div>
                <label><span>AWS region</span><select value={settings.ai.region} onChange={(event) => updateAi("region", event.target.value)}><option value="us-east-1">US East (N. Virginia) · us-east-1</option><option value="us-east-2">US East (Ohio) · us-east-2</option><option value="us-west-2">US West (Oregon) · us-west-2</option><option value="eu-west-1">Europe (Ireland) · eu-west-1</option><option value="eu-central-1">Europe (Frankfurt) · eu-central-1</option><option value="ap-northeast-1">Asia Pacific (Tokyo) · ap-northeast-1</option><option value="ap-southeast-1">Asia Pacific (Singapore) · ap-southeast-1</option><option value="ap-southeast-2">Asia Pacific (Sydney) · ap-southeast-2</option></select></label>
                <label><span>Maximum output tokens</span><input type="number" min="128" step="1" value={settings.ai.maxTokens} onChange={(event) => updateAi("maxTokens", Number(event.target.value))} /><small>PA sends this value to the selected model without imposing an artificial upper limit; the model’s own output limit still applies.</small></label>
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
                <summary><span><strong>Discussion system prompt</strong><small>Ask PA with up to eight selected papers.</small></span><ChevronDown size={16} /></summary>
                <div className="prompt-template-content"><PromptEditor inputRef={promptEditors} promptKey="chatSystem" value={settings.prompts.chatSystem} onChange={(value) => updatePrompt("chatSystem", value)} /><small>PA numbers discussion context as Paper 1, Paper 2, and so on. Insert a placeholder wherever that context should appear.</small><PromptVariables variables={discussionVariables} onInsert={(variable) => insertPromptVariable("chatSystem", variable)} /><button type="button" className="inline-reset" onClick={() => updatePrompt("chatSystem", DEFAULT_CHAT_SYSTEM_PROMPT)}>Restore discussion default</button></div>
              </details>
              <details className="prompt-template-section">
                <summary><span><strong>Summary system prompt</strong><small>Create the reusable PA summary stored with a paper.</small></span><ChevronDown size={16} /></summary>
                <div className="prompt-template-content"><PromptEditor inputRef={promptEditors} promptKey="summarySystem" value={settings.prompts.summarySystem} onChange={(value) => updatePrompt("summarySystem", value)} /><small>Summary placeholders are replaced with the selected paper’s current metadata and extracted content.</small><PromptVariables variables={summaryVariables} onInsert={(variable) => insertPromptVariable("summarySystem", variable)} /><button type="button" className="inline-reset" onClick={() => updatePrompt("summarySystem", DEFAULT_SUMMARY_SYSTEM_PROMPT)}>Restore summary default</button></div>
              </details>
              <details className="prompt-template-section">
                <summary><span><strong>PDF extraction system prompt</strong><small>Extract structured metadata from local PDF text.</small></span><ChevronDown size={16} /></summary>
                <div className="prompt-template-content"><PromptEditor inputRef={promptEditors} promptKey="extractionSystem" value={settings.prompts.extractionSystem} onChange={(value) => updatePrompt("extractionSystem", value)} /><small>Extraction analyzes embedded PDF metadata and the first pages, then returns normalized paper fields.</small><PromptVariables variables={extractionVariables} onInsert={(variable) => insertPromptVariable("extractionSystem", variable)} /><button type="button" className="inline-reset" onClick={() => updatePrompt("extractionSystem", DEFAULT_EXTRACTION_SYSTEM_PROMPT)}>Restore extraction default</button></div>
              </details>
            </div>
            <SettingsFooter saving={saving} onRefresh={() => void loadSettings()} />
          </form>
        ) : null}

        {!loading && tab === "sync" ? (
          <form onSubmit={save}>
            <SettingsHeading icon={<DatabaseBackup size={19} />} title="OneDrive sync" detail="Back up PA’s library database, PDFs, and HTML snapshots." />
            <div className="sync-status-card">
              <span className={`sync-status-icon ${settings.sync.lastResult?.ok ? "is-success" : ""}`}><FolderSync size={20} /></span>
              <div><strong>{settings.sync.lastResult?.summary ?? "Ready to connect OneDrive"}</strong><small>{timeLabel(settings.sync.lastSyncAt)}</small></div>
              <button type="button" className="primary-action" onClick={() => void syncNow()} disabled={syncing || !settings.sync.sourceExists || !settings.sync.remotePath.trim()} title={!settings.sync.sourceExists ? "PA’s local library database is not available" : !settings.sync.remotePath.trim() ? "Choose a OneDrive folder first" : "Back up PA now"}>{syncing ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} {syncing ? "Syncing…" : "Sync now"}</button>
            </div>
            <div className="settings-card">
              <div className="settings-form-grid">
                <label className="span-2"><span>OneDrive remote directory</span><div className="path-picker-control"><input list="onedrive-paths" value={settings.sync.remotePath} onChange={(event) => updateSync("remotePath", event.target.value)} placeholder="~/Library/CloudStorage/OneDrive-…/PA" /><button type="button" onClick={() => void chooseDirectory()} disabled={selectingDirectory}>{selectingDirectory ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />} Choose</button></div><datalist id="onedrive-paths">{settings.sync.detectedPaths.map((path) => <option value={`${path}/PA`} key={path} />)}</datalist><small>PA stores a consistent library backup plus pdfs/ and html_snapshots/ here.</small></label>
                <label><span>Auto-sync interval</span><div className="unit-input"><input type="number" min="5" max="3600" value={settings.sync.autoSyncInterval} onChange={(event) => updateSync("autoSyncInterval", Number(event.target.value))} /><i>seconds</i></div></label>
              </div>
              <label className="settings-toggle"><input type="checkbox" checked={settings.sync.autoSync} onChange={(event) => updateSync("autoSync", event.target.checked)} /><span /><div><strong>Auto-sync after live PA changes</strong><small>Uses local-wins conflict handling for background synchronization.</small></div></label>
              <div className="sync-caution"><ShieldCheck size={16} /><p><strong>The local library remains authoritative.</strong> Sync writes a consistent backup to OneDrive and never replaces the database used by the running PA server.</p></div>
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
      </div>
    </div>
  );
}

function SettingsHeading({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="settings-heading"><span>{icon}</span><div><h2>{title}</h2><p>{detail}</p></div></div>;
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
  return <div className="settings-footer"><button type="button" className="secondary-action" onClick={onRefresh}><RefreshCw size={14} /> Reset</button><button className="primary-action" disabled={saving}>{saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} {saving ? "Saving…" : "Save settings"}</button></div>;
}
