"use client";

import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  CircleDot,
  Clock3,
  Command,
  Compass,
  Database,
  ExternalLink,
  FileText,
  FolderOpen,
  Home,
  Inbox,
  Library,
  Link2,
  ListFilter,
  LoaderCircle,
  Menu,
  Moon,
  PanelRightClose,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings2,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Upload,
  UsersRound,
  WandSparkles,
  X,
} from "lucide-react";
import type { AriaAttributes, ChangeEvent, FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { demoSnapshot } from "@/app/lib/demo-data";
import { SettingsView } from "@/app/components/SettingsView";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { BackgroundTaskProvider, useBackgroundTasks } from "@/app/components/BackgroundTasks";
import type {
  Author,
  ChatMessage,
  Collection,
  DiscoveryResult,
  DiscoveryProvider,
  IdentifierSource,
  LibrarySnapshot,
  Paper,
  Venue,
  ViewId,
} from "@/app/lib/types";

const discoveryProviders: Array<{
  id: DiscoveryProvider;
  label: string;
  detail: string;
}> = [
  { id: "semantic-scholar", label: "Semantic Scholar", detail: "Broad academic metadata and open-access links" },
  { id: "google-scholar", label: "Google Scholar", detail: "Wide web-scale scholarly coverage via SerpAPI" },
  { id: "arxiv", label: "arXiv", detail: "Preprints across physics, mathematics, CS, and more" },
  { id: "dblp", label: "DBLP", detail: "Curated computer-science publications and venues" },
  { id: "crossref", label: "Crossref", detail: "DOI-registered journal, conference, and book metadata" },
];

const identifierSources: Array<{
  id: IdentifierSource;
  label: string;
  placeholder: string;
  hint: string;
}> = [
  { id: "arxiv", label: "arXiv ID", placeholder: "2307.10635", hint: "Fetch metadata and the canonical PDF link." },
  { id: "doi", label: "DOI", placeholder: "10.1038/s41586-023-06647-8", hint: "Resolve publisher metadata through Crossref." },
  { id: "dblp", label: "DBLP URL", placeholder: "https://dblp.org/rec/conf/…", hint: "Import a canonical DBLP publication record." },
  { id: "openreview", label: "OpenReview ID", placeholder: "bq1JEgioLr", hint: "Import a public submission and its PDF link." },
];

type EditablePaperType = "conference" | "journal" | "workshop" | "preprint" | "website" | "other";
type PaperColumnKey = "title" | "venue" | "year" | "status";
type AuthorColumnKey = "author" | "papers" | "latest";
type VenueColumnKey = "venue" | "type" | "publisher" | "papers" | "latest";

const defaultPaperColumnWidths: Record<PaperColumnKey, number> = {
  title: 56,
  venue: 18,
  year: 7,
  status: 9,
};

const defaultAuthorColumnWidths: Record<AuthorColumnKey, number> = {
  author: 66,
  papers: 12,
  latest: 12,
};

const defaultVenueColumnWidths: Record<VenueColumnKey, number> = {
  venue: 32,
  type: 13,
  publisher: 22,
  papers: 10,
  latest: 10,
};

function useResizableColumns<Key extends string>(
  storageKey: string,
  defaults: Record<Key, number>,
  minimums: Record<Key, number>,
) {
  const [widths, setWidths] = useState<Record<Key, number>>(defaults);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Partial<Record<Key, number>> | null;
        if (saved && Object.values(saved).every((value) => typeof value === "number" && Number.isFinite(value))) {
          setWidths((current) => ({ ...current, ...saved }));
        }
      } catch {
        // Invalid browser preferences fall back to the balanced default widths.
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [storageKey]);

  function resizeColumn(event: ReactPointerEvent<HTMLButtonElement>, key: Key) {
    event.preventDefault();
    event.stopPropagation();
    const header = event.currentTarget.closest("th");
    const table = event.currentTarget.closest("table");
    if (!header || !table) {
      return;
    }
    const startX = event.clientX;
    const startWidth = header.getBoundingClientRect().width;
    const tableWidth = table.getBoundingClientRect().width;
    const maximum = Math.max(minimums[key], tableWidth * 0.7);
    const onPointerMove = (moveEvent: PointerEvent) => {
      const width = Math.min(maximum, Math.max(minimums[key], startWidth + moveEvent.clientX - startX));
      const percentage = Number(((width / tableWidth) * 100).toFixed(2));
      setWidths((current) => {
        const next = { ...current, [key]: percentage };
        window.localStorage.setItem(storageKey, JSON.stringify(next));
        return next;
      });
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.classList.remove("is-resizing-column");
    };
    document.body.classList.add("is-resizing-column");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }

  function resetColumnWidth(event: ReactMouseEvent<HTMLButtonElement>, key: Key) {
    event.preventDefault();
    event.stopPropagation();
    setWidths((current) => {
      const next = { ...current, [key]: defaults[key] };
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  }

  return { widths, resizeColumn, resetColumnWidth };
}

const paperTypeOptions: Array<{ value: EditablePaperType; label: string }> = [
  { value: "conference", label: "Conference paper" },
  { value: "journal", label: "Journal article" },
  { value: "workshop", label: "Workshop paper" },
  { value: "preprint", label: "Preprint" },
  { value: "website", label: "Website" },
  { value: "other", label: "Other" },
];

function editablePaperType(value: string): EditablePaperType {
  const match = paperTypeOptions.find((option) => option.value === value);
  return match?.value ?? "other";
}

function metadataVisibility(type: EditablePaperType) {
  const conferenceLike = type === "conference" || type === "workshop";
  const other = type === "other";
  return {
    venueName: conferenceLike || type === "journal" || type === "preprint" || other,
    venueAcronym: conferenceLike || type === "journal" || other,
    volumeIssue: type === "journal" || other,
    pages: conferenceLike || type === "journal" || other,
    doi: type !== "website",
    preprint: type === "preprint" || other,
    url: conferenceLike || type === "preprint" || type === "website" || other,
    pdf: type !== "website",
    html: type === "website",
  };
}

function providerLabel(provider: DiscoveryProvider): string {
  return discoveryProviders.find((item) => item.id === provider)?.label ?? provider;
}

const navigation: Array<{
  id: ViewId;
  label: string;
  icon: typeof Home;
}> = [
  { id: "home", label: "Overview", icon: Home },
  { id: "library", label: "Library", icon: Library },
  { id: "authors", label: "Authors", icon: UsersRound },
  { id: "venues", label: "Venues", icon: Building2 },
  { id: "collections", label: "Collections", icon: FolderOpen },
  { id: "discover", label: "Discover", icon: Compass },
  { id: "settings", label: "Settings", icon: Settings2 },
];

type ModalState =
  | { kind: "add-paper" }
  | { kind: "edit-paper"; paper: Paper }
  | { kind: "entity"; entity: "author" | "venue" | "collection"; record?: Author | Venue | Collection }
  | { kind: "bulk"; entity: "author" | "venue"; ids: string[] }
  | null;

interface ToastState {
  id: number;
  message: string;
  tone: "success" | "error" | "info";
}

type ThemeMode = "dark" | "light";
type LibraryFilterKind = "author" | "venue" | "collection" | "year";
type LibraryFilterJoin = "AND" | "OR";

interface LibraryFilterClause {
  key: string;
  kind: LibraryFilterKind;
  valueId: string;
  label: string;
  join: LibraryFilterJoin;
  negated: boolean;
  openGroups: number;
  closeGroups: number;
}

let libraryFilterSequence = 0;

function createLibraryFilter(kind: LibraryFilterKind, valueId: string, label: string): LibraryFilterClause {
  libraryFilterSequence += 1;
  return {
    key: `library-filter-${libraryFilterSequence}`,
    kind,
    valueId,
    label,
    join: "AND",
    negated: false,
    openGroups: 0,
    closeGroups: 0,
  };
}

interface MutationBody {
  entity: "paper" | "author" | "venue" | "collection";
  action: "create" | "bulk-create" | "update" | "delete" | "bulk-update" | "bulk-delete";
  id?: string;
  ids?: string[];
  data?: Record<string, unknown>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function authorLine(paper: Paper): string {
  const names = paper.authors.map((author) => author.displayName);
  if (names.length <= 3) {
    return names.join(", ");
  }
  return `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

function fullAuthorLine(paper: Paper): string {
  return paper.authors.map((author) => author.displayName).join(", ");
}

function ExpandableAuthorNames({ paper, limit = 3 }: { paper: Paper; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  const authors = paper.authors.map((author) => author.displayName);
  const hiddenCount = Math.max(0, authors.length - limit);
  const visibleAuthors = expanded ? authors : authors.slice(0, limit);

  if (!authors.length) {
    return <span className="expandable-author-list"><span>Authors not recorded</span></span>;
  }

  return (
    <span className={`expandable-author-list ${expanded ? "is-expanded" : ""}`}>
      <span>{visibleAuthors.join(", ")}</span>
      {hiddenCount ? (
        <button
          type="button"
          aria-expanded={expanded}
          title={expanded ? "Hide additional authors" : `Show ${hiddenCount} more ${hiddenCount === 1 ? "author" : "authors"}`}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((current) => !current);
          }}
        >
          {expanded ? "Show fewer" : `More ${hiddenCount} ${hiddenCount === 1 ? "author" : "authors"}`}
        </button>
      ) : null}
    </span>
  );
}

function venueLine(paper: Paper): string {
  return paper.venueAcronym || paper.venueName || "Unassigned venue";
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    inbox: "To read",
    reading: "Reading",
    complete: "Read",
  };
  return labels[value] ?? value;
}

function matchesSearch(values: Array<string | number | null | undefined>, query: string): boolean {
  if (!query.trim()) {
    return true;
  }
  const normalized = query.trim().toLowerCase();
  return values.some((value) => String(value ?? "").toLowerCase().includes(normalized));
}

function matchesLibraryClause(paper: Paper, clause: LibraryFilterClause): boolean {
  const matches = clause.kind === "author"
    ? paper.authors.some((author) => author.id === clause.valueId)
    : clause.kind === "venue"
      ? paper.venueId === clause.valueId
      : clause.kind === "collection"
        ? paper.collections.some((collection) => collection.id === clause.valueId)
        : String(paper.year ?? "") === clause.valueId;
  return clause.negated ? !matches : matches;
}

function matchesLibraryFilters(paper: Paper, clauses: LibraryFilterClause[]): boolean {
  if (!clauses.length) {
    return true;
  }
  type FilterToken = boolean | LibraryFilterJoin | "(" | ")";
  const tokens: FilterToken[] = [];
  clauses.forEach((clause, index) => {
    if (index) {
      tokens.push(clause.join);
    }
    for (let group = 0; group < clause.openGroups; group += 1) {
      tokens.push("(");
    }
    tokens.push(matchesLibraryClause(paper, clause));
    for (let group = 0; group < clause.closeGroups; group += 1) {
      tokens.push(")");
    }
  });
  let cursor = 0;
  function parsePrimary(): boolean {
    const token = tokens[cursor];
    if (token === "(") {
      cursor += 1;
      const value = parseOr();
      if (tokens[cursor] === ")") {
        cursor += 1;
      }
      return value;
    }
    cursor += 1;
    return token === true;
  }
  function parseAnd(): boolean {
    let value = parsePrimary();
    while (tokens[cursor] === "AND") {
      cursor += 1;
      const right = parsePrimary();
      value = value && right;
    }
    return value;
  }
  function parseOr(): boolean {
    let value = parseAnd();
    while (tokens[cursor] === "OR") {
      cursor += 1;
      const right = parseAnd();
      value = value || right;
    }
    return value;
  }
  return parseOr();
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string; detail?: string };
    if (payload.error && payload.detail) {
      return `${payload.error} ${payload.detail}`;
    }
    return payload.error ?? `Request failed with ${response.status}.`;
  } catch {
    return `Request failed with ${response.status}.`;
  }
}

function StatusPill({ status, compact = false }: { status: string; compact?: boolean }) {
  const Icon = status === "complete" ? CheckCircle2 : status === "reading" ? Clock3 : Inbox;
  return (
    <span className={`status-pill status-${status} ${compact ? "is-compact" : ""}`} aria-label={statusLabel(status)} title={compact ? statusLabel(status) : undefined}>
      <Icon size={13} strokeWidth={2} />
      {compact ? null : statusLabel(status)}
    </span>
  );
}

function SelectionBox({ checked }: { checked: boolean }) {
  return (
    <span className={`selection-box ${checked ? "is-checked" : ""}`} aria-hidden="true">
      {checked ? <Check size={13} strokeWidth={3} /> : null}
    </span>
  );
}

function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

export default function PaperAssistant() {
  return <BackgroundTaskProvider><PaperAssistantWorkspace /></BackgroundTaskProvider>;
}

function PaperAssistantWorkspace() {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>(demoSnapshot);
  const [view, setView] = useState<ViewId>("home");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [selectedPaper, setSelectedPaper] = useState<Paper | null>(null);
  const [chatPaper, setChatPaper] = useState<Paper | null>(null);
  const [readerPaper, setReaderPaper] = useState<Paper | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [selectedPapers, setSelectedPapers] = useState<string[]>([]);
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);
  const [selectedVenues, setSelectedVenues] = useState<string[]>([]);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [themeReady, setThemeReady] = useState(false);
  const [libraryName, setLibraryName] = useState("My Paper Library");
  const [libraryFilters, setLibraryFilters] = useState<LibraryFilterClause[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((message: string, tone: ToastState["tone"] = "success") => {
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
    }
    const next = { id: Date.now(), message, tone };
    setToast(next);
    toastTimer.current = setTimeout(() => {
      setToast(null);
    }, 3200);
  }, []);

  async function loadLibrary(showSync = false) {
    if (showSync) {
      setSyncing(true);
    }
    try {
      const response = await fetch("/api/library", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const nextSnapshot = (await response.json()) as LibrarySnapshot;
      setSnapshot(nextSnapshot);
      setSelectedPaper((current) => {
        if (!current) {
          return null;
        }
        return nextSnapshot.papers.find((paper) => paper.id === current.id) ?? null;
      });
      setDemoMode(false);
    } catch {
      setSnapshot(demoSnapshot);
      setDemoMode(true);
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }

  async function mutateLibrary(body: MutationBody, successMessage: string): Promise<boolean> {
    try {
      const response = await fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const nextSnapshot = (await response.json()) as LibrarySnapshot;
      setSnapshot(nextSnapshot);
      setSelectedPaper((current) => {
        if (!current) {
          return null;
        }
        return nextSnapshot.papers.find((paper) => paper.id === current.id) ?? null;
      });
      setReaderPaper((current) => {
        if (!current) {
          return null;
        }
        return nextSnapshot.papers.find((paper) => paper.id === current.id) ?? null;
      });
      setDemoMode(false);
      notify(successMessage);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "That change could not be saved.";
      notify(message, "error");
      return false;
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadLibrary();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedTheme = window.localStorage.getItem("pa-theme");
      const documentTheme = document.documentElement.dataset.theme;
      const nextTheme = savedTheme === "light" || savedTheme === "dark"
        ? savedTheme
        : documentTheme === "light"
          ? "light"
          : "dark";
      setTheme(nextTheme);
      const savedLibraryName = window.localStorage.getItem("pa-library-name")?.trim();
      if (savedLibraryName) {
        setLibraryName(savedLibraryName);
      }
      setThemeReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!themeReady) {
      return;
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("pa-theme", theme);
    window.localStorage.setItem("pa-library-name", libraryName.trim() || "My Paper Library");
  }, [libraryName, theme, themeReady]);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const inField = target?.matches("input, textarea, select, [contenteditable='true']");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((current) => !current);
        return;
      }
      if (event.key === "Escape") {
        setModal(null);
        setCommandOpen(false);
        setSelectedPaper(null);
        setChatPaper(null);
        setReaderPaper(null);
        return;
      }
      if (!inField && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setModal({ kind: "add-paper" });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function changeView(nextView: ViewId) {
    setView(nextView);
    setQuery("");
    setLibraryFilters([]);
    setMobileNav(false);
    setSelectedPaper(null);
  }

  async function deleteRecords(entity: MutationBody["entity"], ids: string[]) {
    if (!ids.length) {
      return;
    }
    const label = ids.length === 1 ? entity : `${entity}s`;
    const approved = window.confirm(`Delete ${ids.length} selected ${label}? This cannot be undone.`);
    if (!approved) {
      return;
    }
    const succeeded = await mutateLibrary(
      { entity, action: ids.length === 1 ? "delete" : "bulk-delete", ids },
      `${ids.length} ${label} deleted.`,
    );
    if (succeeded) {
      if (entity === "paper") {
        setSelectedPapers([]);
        setSelectedPaper(null);
      }
      if (entity === "author") {
        setSelectedAuthors([]);
      }
      if (entity === "venue") {
        setSelectedVenues([]);
      }
    }
  }

  async function updatePaper(paper: Paper, data: Record<string, unknown>, message: string) {
    await mutateLibrary(
      { entity: "paper", action: "update", id: paper.id, data },
      message,
    );
  }

  const currentPaper = useMemo(() => {
    const byRecentActivity = [...snapshot.papers].sort((left, right) => {
      const leftTime = new Date(left.updatedAt || left.addedAt).getTime();
      const rightTime = new Date(right.updatedAt || right.addedAt).getTime();
      return rightTime - leftTime;
    });
    return byRecentActivity.find((paper) => paper.readingStatus === "reading") ?? byRecentActivity[0];
  }, [snapshot.papers]);

  return (
    <div className="pa-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <div className="brand-row">
          <button className="brand" onClick={() => changeView("home")} aria-label="Paper Assistant home">
            <span className="brand-mark">PA</span>
            <span className="brand-copy">
              <strong>Paper Assistant</strong>
            </span>
          </button>
          <button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="Close navigation">
            <X size={18} />
          </button>
        </div>

        <button className="new-paper-button" onClick={() => setModal({ kind: "add-paper" })}>
          <Plus size={17} strokeWidth={2.4} />
          Add paper
          <kbd>N</kbd>
        </button>

        <nav className="main-nav" aria-label="Main navigation">
          <p className="nav-label">Workspace</p>
          {navigation.map((item) => {
            const Icon = item.icon;
            const count = item.id === "library"
              ? snapshot.stats.papers
              : item.id === "authors"
                ? snapshot.stats.authors
                : item.id === "venues"
                  ? snapshot.stats.venues
                  : item.id === "collections"
                    ? snapshot.collections.length
                    : null;
            return (
              <button
                key={item.id}
                className={`nav-item ${view === item.id ? "is-active" : ""}`}
                onClick={() => changeView(item.id)}
              >
                <Icon size={17} strokeWidth={2} />
                <span>{item.label}</span>
                {count !== null ? <span className="nav-count">{count}</span> : null}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-spacer" />

        <button className="assistant-card" onClick={() => setChatPaper(currentPaper ?? null)}>
          <span className="assistant-orb">
            <Sparkles size={17} />
          </span>
          <span>
            <strong>Ask PA</strong>
            <small>Think with your library</small>
          </span>
          <ArrowUpRight size={16} />
        </button>

        <div className="sync-card">
          <span>
            <strong>{demoMode ? "Preview library" : libraryName.trim() || "My Paper Library"}</strong>
            <small>{demoMode ? "Loading library" : `${snapshot.stats.papers} papers · Local library`}</small>
          </span>
          <button className="icon-button" onClick={() => void loadLibrary(true)} aria-label="Refresh library">
            <RefreshCw size={14} className={syncing ? "spin" : ""} />
          </button>
        </div>
      </aside>

      {mobileNav ? <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" /> : null}

      <main className="app-main">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation">
            <Menu size={20} />
          </button>
          <button className="global-search" onClick={() => setCommandOpen(true)}>
            <Search size={17} />
            <span>Search papers, people, venues…</span>
            <span className="shortcut"><Command size={12} /> K</span>
          </button>
          <div className="topbar-actions">
            <button
              className="theme-toggle"
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </header>

        <section className="workspace">
          {loading ? (
            <LoadingWorkspace />
          ) : view === "home" ? (
            <Dashboard
              snapshot={snapshot}
              currentPaper={currentPaper}
              openPaper={setSelectedPaper}
              setView={changeView}
              openChat={setChatPaper}
            />
          ) : view === "library" ? (
            <LibraryView
              papers={snapshot.papers}
              query={query}
              setQuery={setQuery}
              filters={libraryFilters}
              setFilters={setLibraryFilters}
              selected={selectedPapers}
              setSelected={setSelectedPapers}
              openPaper={setSelectedPaper}
              deleteSelected={() => void deleteRecords("paper", selectedPapers)}
              updatePaper={updatePaper}
            />
          ) : view === "authors" ? (
            <AuthorsView
              authors={snapshot.authors}
              query={query}
              setQuery={setQuery}
              selected={selectedAuthors}
              setSelected={setSelectedAuthors}
              onEdit={(author) => setModal({ kind: "entity", entity: "author", record: author })}
              onBulk={() => setModal({ kind: "bulk", entity: "author", ids: selectedAuthors })}
              onDelete={() => void deleteRecords("author", selectedAuthors)}
              onCreate={() => setModal({ kind: "entity", entity: "author" })}
              onOpenPapers={(author) => {
                setQuery("");
                setLibraryFilters([createLibraryFilter("author", author.id, author.displayName)]);
                setView("library");
              }}
            />
          ) : view === "venues" ? (
            <VenuesView
              venues={snapshot.venues}
              query={query}
              setQuery={setQuery}
              selected={selectedVenues}
              setSelected={setSelectedVenues}
              onEdit={(venue) => setModal({ kind: "entity", entity: "venue", record: venue })}
              onBulk={() => setModal({ kind: "bulk", entity: "venue", ids: selectedVenues })}
              onDelete={() => void deleteRecords("venue", selectedVenues)}
              onCreate={() => setModal({ kind: "entity", entity: "venue" })}
              onOpenPapers={(venue) => {
                setQuery("");
                setLibraryFilters([createLibraryFilter("venue", venue.id, venue.acronym || venue.name)]);
                setView("library");
              }}
            />
          ) : view === "collections" ? (
            <CollectionsView
              collections={snapshot.collections}
              papers={snapshot.papers}
              query={query}
              setQuery={setQuery}
              onEdit={(collection) => setModal({ kind: "entity", entity: "collection", record: collection })}
              onDelete={(collection) => void deleteRecords("collection", [collection.id])}
              onCreate={() => setModal({ kind: "entity", entity: "collection" })}
              onOpen={(collection) => {
                setQuery("");
                setLibraryFilters([createLibraryFilter("collection", collection.id, collection.name)]);
                setView("library");
              }}
            />
          ) : view === "discover" ? (
            <DiscoverView
              mutateLibrary={mutateLibrary}
              notify={notify}
              onImport={() => setModal({ kind: "add-paper" })}
            />
          ) : (
            <SettingsView notify={notify} theme={theme} onThemeChange={setTheme} libraryName={libraryName} onLibraryNameChange={setLibraryName} />
          )}
        </section>
      </main>

      {selectedPaper ? (
        <PaperDetail
          paper={selectedPaper}
          onClose={() => setSelectedPaper(null)}
          onUpdate={updatePaper}
          onChat={() => setChatPaper(selectedPaper)}
          onRead={() => setReaderPaper(selectedPaper)}
          onEdit={() => setModal({ kind: "edit-paper", paper: selectedPaper })}
          onDelete={() => void deleteRecords("paper", [selectedPaper.id])}
          onOpenAuthor={(authorName) => {
            const author = selectedPaper.authors.find((candidate) => candidate.displayName === authorName);
            setQuery("");
            setLibraryFilters(author ? [createLibraryFilter("author", author.id, author.displayName)] : []);
            setView("library");
            setSelectedPaper(null);
          }}
          onOpenVenue={() => {
            setQuery("");
            setLibraryFilters(selectedPaper.venueId ? [createLibraryFilter("venue", selectedPaper.venueId, venueLine(selectedPaper))] : []);
            setView("library");
            setSelectedPaper(null);
          }}
          onOpenCollection={(collectionId, collectionName) => {
            setQuery("");
            setLibraryFilters([createLibraryFilter("collection", collectionId, collectionName)]);
            setView("library");
            setSelectedPaper(null);
          }}
        />
      ) : null}

      {readerPaper ? (
        <ReaderDrawer
          paper={readerPaper}
          onClose={() => setReaderPaper(null)}
          onChat={() => setChatPaper(readerPaper)}
        />
      ) : null}

      {chatPaper ? <ChatDrawer paper={chatPaper} papers={snapshot.papers} onClose={() => setChatPaper(null)} /> : null}

      {modal?.kind === "add-paper" ? (
        <AddPaperModal
          onClose={() => setModal(null)}
          mutateLibrary={mutateLibrary}
          notify={notify}
        />
      ) : null}

      {modal?.kind === "edit-paper" ? (
        <PaperEditModal
          paper={modal.paper}
          onClose={() => setModal(null)}
          mutateLibrary={mutateLibrary}
          notify={notify}
        />
      ) : null}

      {modal?.kind === "entity" ? (
        <EntityModal
          entity={modal.entity}
          record={modal.record}
          papers={snapshot.papers}
          onClose={() => setModal(null)}
          mutateLibrary={mutateLibrary}
        />
      ) : null}

      {modal?.kind === "bulk" ? (
        <BulkEditModal
          entity={modal.entity}
          ids={modal.ids}
          onClose={() => setModal(null)}
          mutateLibrary={mutateLibrary}
          onComplete={() => {
            setSelectedAuthors([]);
            setSelectedVenues([]);
          }}
        />
      ) : null}

      {commandOpen ? (
        <CommandPalette
          snapshot={snapshot}
          onClose={() => setCommandOpen(false)}
          setView={changeView}
          openPaper={setSelectedPaper}
          addPaper={() => setModal({ kind: "add-paper" })}
        />
      ) : null}

      {toast ? (
        <div className={`toast toast-${toast.tone}`} role="status" key={toast.id}>
          {toast.tone === "success" ? <CheckCircle2 size={17} /> : toast.tone === "error" ? <CircleDot size={17} /> : <Sparkles size={17} />}
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}

function LoadingWorkspace() {
  return (
    <div className="loading-grid" role="status" aria-label="Loading research library">
      <div className="loading-card loading-wide" />
      <div className="loading-card" />
      <div className="loading-card" />
      <div className="loading-card loading-table" />
    </div>
  );
}

function Dashboard({
  snapshot,
  currentPaper,
  openPaper,
  setView,
  openChat,
}: {
  snapshot: LibrarySnapshot;
  currentPaper?: Paper;
  openPaper: (paper: Paper) => void;
  setView: (view: ViewId) => void;
  openChat: (paper: Paper | null) => void;
}) {
  const recentPapers = snapshot.papers.slice(0, 8);
  const readingProgress = snapshot.stats.papers
    ? Math.round(((snapshot.stats.papers - snapshot.stats.unread) / snapshot.stats.papers) * 100)
    : 0;
  return (
    <div className="dashboard-grid">
      <div className="stat-strip">
        <button className="stat-card" onClick={() => setView("library")}>
          <span className="stat-icon violet"><Library size={18} /></span>
          <span><strong>{snapshot.stats.papers}</strong><small>Papers</small></span>
          <ArrowUpRight size={15} />
        </button>
        <button className="stat-card" onClick={() => setView("authors")}>
          <span className="stat-icon cyan"><UsersRound size={18} /></span>
          <span><strong>{snapshot.stats.authors}</strong><small>Authors</small></span>
          <ArrowUpRight size={15} />
        </button>
        <button className="stat-card" onClick={() => setView("venues")}>
          <span className="stat-icon amber"><Building2 size={18} /></span>
          <span><strong>{snapshot.stats.venues}</strong><small>Venues</small></span>
          <ArrowUpRight size={15} />
        </button>
      </div>

      {currentPaper ? (
        <article className="continue-card">
          <div className="continue-copy">
            <p className="card-kicker" title="This card follows the most recently updated paper marked Reading."><span /> {currentPaper.readingStatus === "reading" ? "Continue reading" : "Latest paper"}</p>
            <h2>{currentPaper.title}</h2>
            <MarkdownContent content={currentPaper.abstract} className="continue-abstract markdown-compact" />
            <div className="paper-byline">
              <span>{fullAuthorLine(currentPaper)}</span>
              <i />
              <span>{venueLine(currentPaper)} · {currentPaper.year}</span>
            </div>
            <div className="continue-actions">
              <button className="light-action" onClick={() => openPaper(currentPaper)}>
                Open paper <ArrowRight size={16} />
              </button>
              <button className="ghost-light" onClick={() => openChat(currentPaper)}>
                <Sparkles size={15} /> Ask PA
              </button>
            </div>
          </div>
          <div className="continue-visual" aria-hidden="true">
            <div className="document-stack document-back" />
            <div className="document-stack document-middle" />
            <div className="document-sheet">
              <div className="sheet-label">PAPER / {currentPaper.year}</div>
              <div className="sheet-title" />
              <div className="sheet-title short" />
              <div className="sheet-rule" />
              <div className="sheet-lines"><span /><span /><span /><span /></div>
              <div className="sheet-chart"><i /><i /><i /><i /><i /></div>
            </div>
          </div>
        </article>
      ) : null}

      <aside className="insight-card">
        <div className="section-title-row">
          <div>
            <p className="eyebrow">Reading pulse</p>
            <h3>{readingProgress}% processed</h3>
          </div>
          <span className="metric-ring" style={{ "--progress": `${readingProgress * 3.6}deg` } as React.CSSProperties}>
            <span>{readingProgress}</span>
          </span>
        </div>
        <div className="reading-bars">
          <div><span>Read</span><i><b style={{ width: `${Math.max(8, ((snapshot.stats.papers - snapshot.stats.unread - snapshot.stats.active) / Math.max(snapshot.stats.papers, 1)) * 100)}%` }} /></i><strong>{snapshot.stats.papers - snapshot.stats.unread - snapshot.stats.active}</strong></div>
          <div><span>Active</span><i><b className="bar-cyan" style={{ width: `${Math.max(8, (snapshot.stats.active / Math.max(snapshot.stats.papers, 1)) * 100)}%` }} /></i><strong>{snapshot.stats.active}</strong></div>
          <div><span>Inbox</span><i><b className="bar-amber" style={{ width: `${Math.max(8, (snapshot.stats.unread / Math.max(snapshot.stats.papers, 1)) * 100)}%` }} /></i><strong>{snapshot.stats.unread}</strong></div>
        </div>
        <button className="text-button" onClick={() => setView("library")}>Review reading queue <ArrowRight size={14} /></button>
      </aside>

      <section className="recent-panel">
        <div className="section-title-row">
          <div>
            <p className="eyebrow">Recently added</p>
            <h3>Fresh in your library</h3>
          </div>
          <button className="text-button" onClick={() => setView("library")}>View all <ArrowRight size={14} /></button>
        </div>
        <div className="recent-list">
          {recentPapers.map((paper) => (
            <article className="recent-row" key={paper.id}>
              <span className={`type-tile type-${paper.paperType}`}><FileText size={18} /></span>
              <span className="recent-copy">
                <button type="button" className="recent-title-button" onClick={() => openPaper(paper)}><strong>{paper.title}</strong></button>
                <span className="recent-meta"><ExpandableAuthorNames paper={paper} /><span>· {venueLine(paper)} {paper.year}</span></span>
              </span>
              <StatusPill status={paper.readingStatus} />
              <button type="button" className="recent-open-button" onClick={() => openPaper(paper)} aria-label={`Open ${paper.title}`}><ArrowUpRight size={16} className="row-arrow" /></button>
            </article>
          ))}
        </div>
      </section>

    </div>
  );
}

function LibraryView({
  papers,
  query,
  setQuery,
  filters,
  setFilters,
  selected,
  setSelected,
  openPaper,
  deleteSelected,
  updatePaper,
}: {
  papers: Paper[];
  query: string;
  setQuery: (value: string) => void;
  filters: LibraryFilterClause[];
  setFilters: (filters: LibraryFilterClause[]) => void;
  selected: string[];
  setSelected: (value: string[]) => void;
  openPaper: (paper: Paper) => void;
  deleteSelected: () => void;
  updatePaper: (paper: Paper, data: Record<string, unknown>, message: string) => Promise<void>;
}) {
  const [status, setStatus] = useState("all");
  const [filterKind, setFilterKind] = useState<LibraryFilterKind>("collection");
  const [filterValue, setFilterValue] = useState("");
  const [filterBuilderOpen, setFilterBuilderOpen] = useState(true);
  const [sort, setSort] = useState<{ key: "recent" | "title" | "venue" | "year" | "status"; direction: "asc" | "desc" }>({ key: "recent", direction: "desc" });
  const [columnWidths, setColumnWidths] = useState<Record<PaperColumnKey, number>>(defaultPaperColumnWidths);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
      const saved = JSON.parse(window.localStorage.getItem("pa-paper-grid-widths-v3") ?? "null") as Partial<Record<PaperColumnKey, number>> | null;
        if (saved && Object.values(saved).every((value) => typeof value === "number" && Number.isFinite(value))) {
          setColumnWidths((current) => ({ ...current, ...saved }));
        }
      } catch {
        // Invalid browser preferences fall back to the balanced default widths.
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const filtered = useMemo(() => {
    const result = papers.filter((paper) => {
      const statusMatch = status === "all" || paper.readingStatus === status || (status === "favorite" && paper.favorite);
      const filterMatch = matchesLibraryFilters(paper, filters);
      const queryMatch = matchesSearch(
        [paper.title, paper.abstract, paper.year, paper.venueName, paper.venueAcronym, ...paper.authors.map((author) => author.displayName), ...paper.collections.map((collection) => collection.name)],
        query,
      );
      return statusMatch && filterMatch && queryMatch;
    });
    return result.sort((left, right) => {
      let comparison = 0;
      if (sort.key === "title") {
        comparison = left.title.localeCompare(right.title);
      } else if (sort.key === "venue") {
        comparison = venueLine(left).localeCompare(venueLine(right));
      } else if (sort.key === "year") {
        comparison = (left.year ?? 0) - (right.year ?? 0);
      } else if (sort.key === "status") {
        const statusOrder: Record<string, number> = { reading: 0, inbox: 1, complete: 2 };
        comparison = (statusOrder[left.readingStatus] ?? 9) - (statusOrder[right.readingStatus] ?? 9);
      } else {
        comparison = new Date(left.addedAt).getTime() - new Date(right.addedAt).getTime();
      }
      return sort.direction === "asc" ? comparison : -comparison;
    });
  }, [filters, papers, query, sort, status]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pagedPapers = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const filterOptions = useMemo<Record<LibraryFilterKind, Array<{ id: string; label: string }>>>(() => {
    function collectionOptions() {
      const options = new Map<string, string>();
      papers.forEach((paper) => paper.collections.forEach((collection) => options.set(collection.id, collection.name)));
      return Array.from(options, ([id, label]) => ({ id, label })).sort((left, right) => left.label.localeCompare(right.label));
    }
    function authorOptions() {
      const options = new Map<string, string>();
      papers.forEach((paper) => paper.authors.forEach((author) => options.set(author.id, author.displayName)));
      return Array.from(options, ([id, label]) => ({ id, label })).sort((left, right) => left.label.localeCompare(right.label));
    }
    function yearOptions() {
      return Array.from(new Set(papers.map((paper) => paper.year).filter((year): year is number => typeof year === "number")))
        .sort((left, right) => right - left)
        .map((year) => ({ id: String(year), label: String(year) }));
    }
    function venueOptions() {
      const options = new Map<string, string>();
      papers.forEach((paper) => {
        if (paper.venueId) {
          options.set(paper.venueId, venueLine(paper));
        }
      });
      return Array.from(options, ([id, label]) => ({ id, label })).sort((left, right) => left.label.localeCompare(right.label));
    }
    return {
      collection: collectionOptions(),
      author: authorOptions(),
      venue: venueOptions(),
      year: yearOptions(),
    };
  }, [papers]);
  const effectivePaperColumnWidths = {
    title: Math.max(38, columnWidths.title),
    venue: Math.min(28, Math.max(12, columnWidths.venue)),
    year: Math.min(6, Math.max(4.5, columnWidths.year)),
    status: Math.min(8, Math.max(6, columnWidths.status)),
  };
  const paperColumnTotal = Object.values(effectivePaperColumnWidths).reduce((total, width) => total + width, 0);

  function toggleSort(key: PaperColumnKey) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: key === "year" ? "desc" : "asc" });
  }

  function resizeColumn(event: ReactPointerEvent<HTMLButtonElement>, key: PaperColumnKey) {
    event.preventDefault();
    event.stopPropagation();
    const header = event.currentTarget.closest("th");
    const table = event.currentTarget.closest("table");
    if (!header || !table) {
      return;
    }
    const startX = event.clientX;
    const startWidth = header.getBoundingClientRect().width;
    const tableWidth = table.getBoundingClientRect().width;
    const minimums: Record<PaperColumnKey, number> = { title: 280, venue: 140, year: 72, status: 72 };
    const maximum = Math.max(minimums[key], tableWidth * (key === "title" ? 0.68 : 0.32));
    const onPointerMove = (moveEvent: PointerEvent) => {
      const width = Math.min(maximum, Math.max(minimums[key], startWidth + moveEvent.clientX - startX));
      const percentage = Number(((width / tableWidth) * 100).toFixed(2));
      setColumnWidths((current) => {
        const next = { ...current, [key]: percentage };
        window.localStorage.setItem("pa-paper-grid-widths-v3", JSON.stringify(next));
        return next;
      });
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.classList.remove("is-resizing-column");
    };
    document.body.classList.add("is-resizing-column");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }

  function resetColumnWidth(event: ReactMouseEvent<HTMLButtonElement>, key: PaperColumnKey) {
    event.preventDefault();
    event.stopPropagation();
    setColumnWidths((current) => {
      const next = { ...current, [key]: defaultPaperColumnWidths[key] };
      window.localStorage.setItem("pa-paper-grid-widths-v3", JSON.stringify(next));
      return next;
    });
  }

  function toggleAll() {
    const visibleIds = pagedPapers.map((paper) => paper.id);
    if (visibleIds.every((id) => selected.includes(id))) {
      setSelected(selected.filter((id) => !visibleIds.includes(id)));
    } else {
      setSelected(Array.from(new Set([...selected, ...visibleIds])));
    }
  }

  function updateFilter(key: string, update: Partial<LibraryFilterClause>) {
    setFilters(filters.map((clause) => clause.key === key ? { ...clause, ...update } : clause));
    setPage(1);
  }

  function changeFilterKind(clause: LibraryFilterClause, kind: LibraryFilterKind) {
    const option = filterOptions[kind][0];
    updateFilter(clause.key, { kind, valueId: option?.id ?? "", label: option?.label ?? "" });
  }

  function addFilter() {
    const option = filterOptions[filterKind].find((candidate) => candidate.id === filterValue);
    if (!option) {
      return;
    }
    setFilters([...filters, createLibraryFilter(filterKind, option.id, option.label)]);
    setFilterValue("");
    setPage(1);
  }

  return (
    <div className="data-view">
      <div className="view-toolbar library-toolbar">
        <PageSearch value={query} onChange={(value) => { setQuery(value); setPage(1); }} placeholder="Search titles, authors, venues…" />
        <button type="button" className={`filter-builder-toggle ${filters.length ? "has-filters" : ""}`} onClick={() => setFilterBuilderOpen((current) => !current)} aria-expanded={filterBuilderOpen} title="Build library filters"><ListFilter size={16} /><span>Filters</span>{filters.length ? <b>{filters.length}</b> : null}</button>
        <div className="filter-tabs">
          {["all", "inbox", "reading", "complete", "favorite"].map((item) => (
            <button key={item} className={status === item ? "is-active" : ""} onClick={() => { setStatus(item); setPage(1); }}>
              {item === "all" ? "All" : item === "favorite" ? "Starred" : statusLabel(item)}
            </button>
          ))}
        </div>
        {selected.length ? (
          <div className="library-selection-actions">
            <span><CheckCircle2 size={15} /> {selected.length} selected</span>
            <button className="selection-icon-button" onClick={() => setSelected([])} aria-label="Clear selection" title="Clear selection"><X size={15} /></button>
            <button className="selection-icon-button is-danger" onClick={deleteSelected} aria-label="Delete selected papers" title="Delete selected papers"><Trash2 size={15} /></button>
          </div>
        ) : null}
      </div>

      {filterBuilderOpen ? (
        <section className="filter-builder-panel" aria-label="Library filter expression">
          <header><span><ListFilter size={15} /><strong>Filter expression</strong><small>Combine exact library records with AND, OR, NOT, and parentheses.</small></span>{filters.length ? <button type="button" onClick={() => { setFilters([]); setPage(1); }}><X size={14} /> Clear all</button> : null}</header>
          <div className="filter-clause-list">
            {filters.map((clause, index) => (
              <div className="filter-clause-row" key={clause.key}>
                {index ? <select aria-label={`Relationship before ${clause.label}`} value={clause.join} onChange={(event) => updateFilter(clause.key, { join: event.target.value as LibraryFilterJoin })}><option value="AND">AND</option><option value="OR">OR</option></select> : <span className="filter-start">WHERE</span>}
                <button type="button" className={clause.openGroups ? "is-active" : ""} onClick={() => updateFilter(clause.key, { openGroups: (clause.openGroups + 1) % 3 })} aria-label="Add opening parenthesis">{clause.openGroups ? "(".repeat(clause.openGroups) : "("}</button>
                <button type="button" className={clause.negated ? "is-active" : ""} onClick={() => updateFilter(clause.key, { negated: !clause.negated })} aria-pressed={clause.negated}>NOT</button>
                <select aria-label={`Field for ${clause.label}`} value={clause.kind} onChange={(event) => changeFilterKind(clause, event.target.value as LibraryFilterKind)}><option value="collection">Collection</option><option value="author">Author</option><option value="venue">Venue</option><option value="year">Year</option></select>
                <span>=</span>
                <select aria-label={`Value for ${clause.kind}`} value={clause.valueId} onChange={(event) => { const option = filterOptions[clause.kind].find((candidate) => candidate.id === event.target.value); if (option) updateFilter(clause.key, { valueId: option.id, label: option.label }); }}>{filterOptions[clause.kind].map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select>
                <button type="button" className={clause.closeGroups ? "is-active" : ""} onClick={() => updateFilter(clause.key, { closeGroups: (clause.closeGroups + 1) % 3 })} aria-label="Add closing parenthesis">{clause.closeGroups ? ")".repeat(clause.closeGroups) : ")"}</button>
                <button type="button" className="is-danger" onClick={() => { setFilters(filters.filter((candidate) => candidate.key !== clause.key)); setPage(1); }} aria-label={`Remove ${clause.kind} filter`}><Trash2 size={14} /></button>
              </div>
            ))}
            <div className="filter-clause-row filter-clause-add">
              <span className="filter-start">ADD</span>
              <select aria-label="New filter field" value={filterKind} onChange={(event) => { setFilterKind(event.target.value as LibraryFilterKind); setFilterValue(""); }}><option value="collection">Collection</option><option value="author">Author</option><option value="venue">Venue</option><option value="year">Year</option></select>
              <span>=</span>
              <select aria-label={`New ${filterKind} filter value`} value={filterValue} onChange={(event) => setFilterValue(event.target.value)}><option value="">Choose…</option>{filterOptions[filterKind].map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select>
              <button type="button" className="filter-add-button" onClick={addFilter} disabled={!filterValue} aria-label="Add filter"><Plus size={14} /> Add</button>
            </div>
          </div>
        </section>
      ) : null}

      {filtered.length ? (
        <div className="paper-table-wrap paper-grid-shell">
          <TablePagination
            page={currentPage}
            pageSize={pageSize}
            total={filtered.length}
            itemLabel="papers"
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
          />
          <table className="paper-table research-grid">
            <colgroup>
              <col className="paper-column-check" />
              <col style={{ width: `${(effectivePaperColumnWidths.title / paperColumnTotal) * 94}%` }} />
              <col style={{ width: `${(effectivePaperColumnWidths.venue / paperColumnTotal) * 94}%` }} />
              <col style={{ width: `${(effectivePaperColumnWidths.year / paperColumnTotal) * 94}%` }} />
              <col style={{ width: `${(effectivePaperColumnWidths.status / paperColumnTotal) * 94}%` }} />
            </colgroup>
            <thead>
              <tr>
                <th className="check-cell" scope="col">
                  <button onClick={toggleAll} aria-label="Select all visible papers">
                    <SelectionBox checked={Boolean(pagedPapers.length) && pagedPapers.every((paper) => selected.includes(paper.id))} />
                  </button>
                </th>
                <SortablePaperHeader label="Paper" sortKey="title" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
                <SortablePaperHeader label="Venue" sortKey="venue" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
                <SortablePaperHeader label="Year" sortKey="year" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
                <SortablePaperHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
              </tr>
            </thead>
            <tbody>
              {pagedPapers.map((paper) => (
                <tr key={paper.id} className={selected.includes(paper.id) ? "is-selected" : ""} onClick={() => openPaper(paper)}>
                  <td className="check-cell">
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        if (selected.includes(paper.id)) {
                          setSelected(selected.filter((id) => id !== paper.id));
                        } else {
                          setSelected([...selected, paper.id]);
                        }
                      }}
                      aria-label={`Select ${paper.title}`}
                    >
                      <SelectionBox checked={selected.includes(paper.id)} />
                    </button>
                  </td>
                  <td className="paper-main-column">
                    <div className="paper-title-cell">
                      <button
                        className={`star-button ${paper.favorite ? "is-starred" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          void updatePaper(paper, { favorite: !paper.favorite }, paper.favorite ? "Removed from starred papers." : "Paper starred.");
                        }}
                        aria-label={paper.favorite ? "Unstar paper" : "Star paper"}
                      >
                        <Star size={15} fill={paper.favorite ? "currentColor" : "none"} />
                      </button>
                      <span>
                        <strong>{paper.title}</strong>
                        <span className="paper-secondary-line">
                          <ExpandableAuthorNames paper={paper} />
                        </span>
                        <span className="paper-collection-line" aria-label="Collections">
                          {paper.collections.slice(0, 3).map((collection) => <i key={collection.id} className="collection-chip">{collection.name}</i>)}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td><span className="venue-cell"><b>{paper.venueAcronym || paper.venueName || "—"}</b><small>{paper.paperType}</small></span></td>
                  <td className="muted-cell year-cell">{paper.year ?? "—"}</td>
                  <td className="status-cell"><StatusPill status={paper.readingStatus} compact /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <TablePagination
            page={currentPage}
            pageSize={pageSize}
            total={filtered.length}
            itemLabel="papers"
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
          />
        </div>
      ) : (
        <EmptyState icon={<Search size={24} />} title="No papers found" detail="Try another search or clear the current filters." />
      )}
    </div>
  );
}

function SortablePaperHeader({ label, sortKey, sort, onSort, onResize, onResetWidth }: {
  label: string;
  sortKey: PaperColumnKey;
  sort: { key: "recent" | "title" | "venue" | "year" | "status"; direction: "asc" | "desc" };
  onSort: (key: PaperColumnKey) => void;
  onResize: (event: ReactPointerEvent<HTMLButtonElement>, key: PaperColumnKey) => void;
  onResetWidth: (event: ReactMouseEvent<HTMLButtonElement>, key: PaperColumnKey) => void;
}) {
  const active = sort.key === sortKey;
  const ariaSort: AriaAttributes["aria-sort"] = active
    ? sort.direction === "asc" ? "ascending" : "descending"
    : "none";
  return (
    <th aria-sort={ariaSort} className={`is-resizable ${sortKey === "year" || sortKey === "status" ? "is-centered" : ""}`}>
      <button type="button" className={`table-sort-button ${active ? "is-active" : ""}`} onClick={() => onSort(sortKey)}>
        <span>{label}</span>
        {active ? sort.direction === "asc" ? <ChevronUp size={14} /> : <ChevronDown size={14} /> : null}
      </button>
      <button
        type="button"
        className="column-resize-handle"
        aria-label={`Resize ${label} column`}
        title={`Drag to resize ${label}; double-click to reset`}
        onPointerDown={(event) => onResize(event, sortKey)}
        onDoubleClick={(event) => onResetWidth(event, sortKey)}
      />
    </th>
  );
}

function AuthorsView({
  authors,
  query,
  setQuery,
  selected,
  setSelected,
  onEdit,
  onBulk,
  onDelete,
  onCreate,
  onOpenPapers,
}: {
  authors: Author[];
  query: string;
  setQuery: (value: string) => void;
  selected: string[];
  setSelected: (value: string[]) => void;
  onEdit: (author: Author) => void;
  onBulk: () => void;
  onDelete: () => void;
  onCreate: () => void;
  onOpenPapers: (author: Author) => void;
}) {
  const [sort, setSort] = useState<{ key: "author" | "papers" | "latest"; direction: "asc" | "desc" }>({ key: "author", direction: "asc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const { widths, resizeColumn, resetColumnWidth } = useResizableColumns<AuthorColumnKey>(
    "pa-author-grid-widths-v3",
    defaultAuthorColumnWidths,
    { author: 260, papers: 80, latest: 80 },
  );
  const filtered = useMemo(() => authors
    .filter((author) => matchesSearch([author.displayName, author.givenName, author.familyName, author.notes], query))
    .sort((left, right) => {
      let comparison = 0;
      if (sort.key === "author") comparison = left.displayName.localeCompare(right.displayName);
      if (sort.key === "papers") comparison = left.paperCount - right.paperCount;
      if (sort.key === "latest") comparison = (left.latestYear ?? 0) - (right.latestYear ?? 0);
      return sort.direction === "asc" ? comparison : -comparison;
    }), [authors, query, sort]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pagedAuthors = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const authorColumnTotal = Object.values(widths).reduce((total, width) => total + width, 0);
  function toggleSort(key: typeof sort.key) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: key === "papers" || key === "latest" ? "desc" : "asc" });
  }
  function toggleAll() {
    const visibleIds = pagedAuthors.map((author) => author.id);
    if (visibleIds.every((id) => selected.includes(id))) {
      setSelected(selected.filter((id) => !visibleIds.includes(id)));
      return;
    }
    setSelected(Array.from(new Set([...selected, ...visibleIds])));
  }
  return (
    <div className="data-view">
      <EntityToolbar query={query} setQuery={(value) => { setQuery(value); setPage(1); }} placeholder="Search author names…" selected={selected.length} onClear={() => setSelected([])} onBulk={onBulk} onDelete={onDelete} onCreate={onCreate} createLabel="Add author" />
      <div className="data-grid-shell author-table-wrap">
        <TablePagination
          page={currentPage}
          pageSize={pageSize}
          total={filtered.length}
          itemLabel="authors"
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        />
        <table className="paper-table research-grid entity-research-grid author-grid">
          <colgroup>
            <col className="paper-column-check" />
            <col style={{ width: `${(widths.author / authorColumnTotal) * 90}%` }} />
            <col style={{ width: `${(widths.papers / authorColumnTotal) * 90}%` }} />
            <col style={{ width: `${(widths.latest / authorColumnTotal) * 90}%` }} />
            <col className="entity-column-actions" />
          </colgroup>
          <thead>
            <tr>
              <th className="check-cell" scope="col">
                <button onClick={toggleAll} aria-label="Select all visible authors">
                  <SelectionBox checked={Boolean(pagedAuthors.length) && pagedAuthors.every((author) => selected.includes(author.id))} />
                </button>
              </th>
              <SortableEntityHeader label="Author" columnKey="author" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
              <SortableEntityHeader label="Papers" columnKey="papers" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} centered />
              <SortableEntityHeader label="Latest" columnKey="latest" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} centered />
              <th className="actions-cell" scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {pagedAuthors.map((author, index) => (
              <tr className={selected.includes(author.id) ? "is-selected" : ""} key={author.id}>
                <td className="check-cell">
                  <button onClick={() => {
                    if (selected.includes(author.id)) {
                      setSelected(selected.filter((id) => id !== author.id));
                    } else {
                      setSelected([...selected, author.id]);
                    }
                  }} aria-label={`Select ${author.displayName}`}><SelectionBox checked={selected.includes(author.id)} /></button>
                </td>
                <td>
                  <button className="entity-primary-button" onClick={() => onOpenPapers(author)}>
                    <span className={`compact-avatar avatar-${index % 5}`}>{initials(author.displayName)}</span>
                    <span><strong>{author.displayName}</strong></span>
                  </button>
                </td>
                <td className="entity-number-cell">{author.paperCount}</td>
                <td className="entity-number-cell">{author.latestYear ?? "—"}</td>
                <td className="actions-cell"><button className="row-icon-button" onClick={() => onEdit(author)} aria-label={`Edit ${author.displayName}`} title="Edit author"><Pencil size={15} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <TablePagination
          page={currentPage}
          pageSize={pageSize}
          total={filtered.length}
          itemLabel="authors"
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        />
      </div>
      {!filtered.length ? <EmptyState icon={<UsersRound size={24} />} title="No authors found" detail="Try another author name." /> : null}
    </div>
  );
}

function VenuesView({
  venues,
  query,
  setQuery,
  selected,
  setSelected,
  onEdit,
  onBulk,
  onDelete,
  onCreate,
  onOpenPapers,
}: {
  venues: Venue[];
  query: string;
  setQuery: (value: string) => void;
  selected: string[];
  setSelected: (value: string[]) => void;
  onEdit: (venue: Venue) => void;
  onBulk: () => void;
  onDelete: () => void;
  onCreate: () => void;
  onOpenPapers: (venue: Venue) => void;
}) {
  const [sort, setSort] = useState<{ key: "venue" | "type" | "publisher" | "papers" | "latest"; direction: "asc" | "desc" }>({ key: "venue", direction: "asc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const { widths, resizeColumn, resetColumnWidth } = useResizableColumns<VenueColumnKey>(
    "pa-venue-grid-widths-v2",
    defaultVenueColumnWidths,
    { venue: 220, type: 100, publisher: 150, papers: 80, latest: 80 },
  );
  const filtered = useMemo(() => venues
    .filter((venue) => matchesSearch([venue.name, venue.acronym, venue.type, venue.publisher], query))
    .sort((left, right) => {
      let comparison = 0;
      if (sort.key === "venue") comparison = left.name.localeCompare(right.name);
      if (sort.key === "type") comparison = left.type.localeCompare(right.type);
      if (sort.key === "publisher") comparison = (left.publisher ?? "").localeCompare(right.publisher ?? "");
      if (sort.key === "papers") comparison = left.paperCount - right.paperCount;
      if (sort.key === "latest") comparison = (left.latestYear ?? 0) - (right.latestYear ?? 0);
      return sort.direction === "asc" ? comparison : -comparison;
    }), [query, sort, venues]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pagedVenues = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const venueColumnTotal = Object.values(widths).reduce((total, width) => total + width, 0);
  function toggleSort(key: typeof sort.key) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: key === "papers" || key === "latest" ? "desc" : "asc" });
  }
  function toggleAll() {
    const visibleIds = pagedVenues.map((venue) => venue.id);
    if (visibleIds.every((id) => selected.includes(id))) {
      setSelected(selected.filter((id) => !visibleIds.includes(id)));
      return;
    }
    setSelected(Array.from(new Set([...selected, ...visibleIds])));
  }
  return (
    <div className="data-view">
      <EntityToolbar query={query} setQuery={(value) => { setQuery(value); setPage(1); }} placeholder="Search venue names, types, and publishers…" selected={selected.length} onClear={() => setSelected([])} onBulk={onBulk} onDelete={onDelete} onCreate={onCreate} createLabel="Add venue" />
      <div className="data-grid-shell venue-table-wrap">
        <TablePagination
          page={currentPage}
          pageSize={pageSize}
          total={filtered.length}
          itemLabel="venues"
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        />
        <table className="paper-table research-grid entity-research-grid venue-grid">
          <colgroup>
            <col className="paper-column-check" />
            <col style={{ width: `${(widths.venue / venueColumnTotal) * 90}%` }} />
            <col style={{ width: `${(widths.type / venueColumnTotal) * 90}%` }} />
            <col style={{ width: `${(widths.publisher / venueColumnTotal) * 90}%` }} />
            <col style={{ width: `${(widths.papers / venueColumnTotal) * 90}%` }} />
            <col style={{ width: `${(widths.latest / venueColumnTotal) * 90}%` }} />
            <col className="entity-column-actions" />
          </colgroup>
          <thead>
            <tr>
              <th className="check-cell" scope="col">
                <button onClick={toggleAll} aria-label="Select all visible venues">
                  <SelectionBox checked={Boolean(pagedVenues.length) && pagedVenues.every((venue) => selected.includes(venue.id))} />
                </button>
              </th>
              <SortableEntityHeader label="Venue" columnKey="venue" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
              <SortableEntityHeader label="Type" columnKey="type" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
              <SortableEntityHeader label="Publisher" columnKey="publisher" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
              <SortableEntityHeader label="Papers" columnKey="papers" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} centered />
              <SortableEntityHeader label="Latest" columnKey="latest" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} centered />
              <th className="actions-cell" scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {pagedVenues.map((venue) => (
              <tr className={selected.includes(venue.id) ? "is-selected" : ""} key={venue.id}>
                <td className="check-cell">
                  <button onClick={() => {
                    if (selected.includes(venue.id)) {
                      setSelected(selected.filter((id) => id !== venue.id));
                    } else {
                      setSelected([...selected, venue.id]);
                    }
                  }} aria-label={`Select ${venue.name}`}><SelectionBox checked={selected.includes(venue.id)} /></button>
                </td>
                <td>
                  <button className="entity-primary-button" onClick={() => onOpenPapers(venue)}>
                    <span className="venue-monogram">{(venue.acronym || venue.name).slice(0, 4)}</span>
                    <span><strong>{venue.name}</strong><small>{venue.acronym || "No acronym"}</small></span>
                  </button>
                </td>
                <td className="entity-meta-cell entity-type-cell">{venue.type}</td>
                <td className="entity-meta-cell">{venue.publisher || "—"}</td>
                <td className="entity-number-cell">{venue.paperCount}</td>
                <td className="entity-number-cell">{venue.latestYear ?? "—"}</td>
                <td className="actions-cell"><button className="row-icon-button" onClick={() => onEdit(venue)} aria-label={`Edit ${venue.name}`} title="Edit venue"><Pencil size={15} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <TablePagination
          page={currentPage}
          pageSize={pageSize}
          total={filtered.length}
          itemLabel="venues"
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        />
      </div>
      {!filtered.length ? <EmptyState icon={<Building2 size={24} />} title="No venues found" detail="Try a different conference, journal, or publisher." /> : null}
    </div>
  );
}

function CollectionsView({
  collections,
  papers,
  query,
  setQuery,
  onEdit,
  onDelete,
  onCreate,
  onOpen,
}: {
  collections: Collection[];
  papers: Paper[];
  query: string;
  setQuery: (value: string) => void;
  onEdit: (collection: Collection) => void;
  onDelete: (collection: Collection) => void;
  onCreate: () => void;
  onOpen: (collection: Collection) => void;
}) {
  const filtered = collections.filter((collection) => matchesSearch([collection.name], query));
  return (
    <div className="data-view">
      <div className="view-toolbar compact-toolbar"><PageSearch value={query} onChange={setQuery} placeholder="Search collections…" /><ToolbarCreateButton label="Add collection" onClick={onCreate} /></div>
      <div className="collection-grid">
        {filtered.map((collection) => {
          const related = papers.filter((paper) => paper.collections.some((paperCollection) => paperCollection.id === collection.id));
          return (
            <article className="collection-card" key={collection.id}>
              <header className="collection-card-top">
                <button type="button" className="collection-heading" onClick={() => onOpen(collection)}>
                  <span className="collection-icon"><FolderOpen size={18} /></span>
                  <span><strong>{collection.name}</strong><small>{collection.paperCount} {collection.paperCount === 1 ? "paper" : "papers"}</small></span>
                </button>
                <div className="collection-actions">
                  <button type="button" className="row-icon-button" onClick={() => onEdit(collection)} aria-label={`Edit ${collection.name}`} title="Edit collection"><Pencil size={15} /></button>
                  <button type="button" className="row-icon-button is-danger" onClick={() => onDelete(collection)} aria-label={`Delete ${collection.name}`} title="Delete collection"><Trash2 size={15} /></button>
                </div>
              </header>
              <button type="button" className="collection-papers" onClick={() => onOpen(collection)} aria-label={`Open papers in ${collection.name}`}>
                {related.slice(0, 5).map((paper) => <span key={paper.id}><FileText size={14} /><b>{paper.title}</b></span>)}
                {related.length > 5 ? <small>+{related.length - 5} more papers</small> : null}
                {!related.length ? <span className="row-muted"><FileText size={14} /><b>Add papers to this collection</b></span> : null}
              </button>
            </article>
          );
        })}
      </div>
      {!filtered.length ? <EmptyState icon={<FolderOpen size={24} />} title="No collections found" detail="Create a focused space for your next research question." /> : null}
    </div>
  );
}

function SortableEntityHeader<Key extends string>({
  label,
  columnKey,
  sort,
  onSort,
  onResize,
  onResetWidth,
  centered = false,
}: {
  label: string;
  columnKey: Key;
  sort: { key: string; direction: "asc" | "desc" };
  onSort: (key: Key) => void;
  onResize: (event: ReactPointerEvent<HTMLButtonElement>, key: Key) => void;
  onResetWidth: (event: ReactMouseEvent<HTMLButtonElement>, key: Key) => void;
  centered?: boolean;
}) {
  const active = sort.key === columnKey;
  const ariaSort: AriaAttributes["aria-sort"] = active
    ? sort.direction === "asc" ? "ascending" : "descending"
    : "none";
  return (
    <th aria-sort={ariaSort} className={`is-resizable ${centered ? "is-centered" : ""}`}>
      <button type="button" className={`table-sort-button ${active ? "is-active" : ""}`} onClick={() => onSort(columnKey)}>
        <span>{label}</span>
        {active ? sort.direction === "asc" ? <ChevronUp size={14} /> : <ChevronDown size={14} /> : null}
      </button>
      <button
        type="button"
        className="column-resize-handle"
        aria-label={`Resize ${label} column`}
        title={`Drag to resize ${label}; double-click to reset`}
        onPointerDown={(event) => onResize(event, columnKey)}
        onDoubleClick={(event) => onResetWidth(event, columnKey)}
      />
    </th>
  );
}

function EntityToolbar({ query, setQuery, placeholder, selected, onClear, onBulk, onDelete, onCreate, createLabel }: {
  query: string;
  setQuery: (value: string) => void;
  placeholder: string;
  selected: number;
  onClear: () => void;
  onBulk: () => void;
  onDelete: () => void;
  onCreate: () => void;
  createLabel: string;
}) {
  return (
    <div className="view-toolbar entity-toolbar">
      <PageSearch value={query} onChange={setQuery} placeholder={placeholder} />
      {selected ? (
        <div className="selection-actions">
          <span>{selected} selected</span>
          <button className="selection-icon-button" onClick={onBulk} aria-label="Bulk edit selected records" title="Bulk edit"><Pencil size={15} /></button>
          <button className="selection-icon-button is-danger" onClick={onDelete} aria-label="Delete selected records" title="Delete selected"><Trash2 size={15} /></button>
          <button className="selection-icon-button" onClick={onClear} aria-label="Clear selection" title="Clear selection"><X size={15} /></button>
        </div>
      ) : null}
      <ToolbarCreateButton label={createLabel} onClick={onCreate} />
    </div>
  );
}

function ToolbarCreateButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="toolbar-create-button" onClick={onClick} aria-label={label} title={label}><Plus size={17} /></button>;
}

function PageSearch({ value, onChange, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="inline-search page-search">
      <Search size={18} aria-hidden="true" />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value ? <button type="button" onClick={() => onChange("")} aria-label="Clear search" title="Clear search"><X size={14} /></button> : null}
    </label>
  );
}

function TablePagination({ page, pageSize, total, itemLabel, onPageChange, onPageSizeChange }: {
  page: number;
  pageSize: number;
  total: number;
  itemLabel: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);
  const nearbyPages = Array.from(new Set([1, 2, page - 1, page, page + 1, pageCount - 1, pageCount]))
    .filter((candidate) => candidate >= 1 && candidate <= pageCount)
    .sort((left, right) => left - right);
  const pageItems: Array<number | string> = [];
  nearbyPages.forEach((candidate, index) => {
    const previous = nearbyPages[index - 1];
    if (previous && candidate - previous > 1) {
      pageItems.push(`ellipsis-${previous}`);
    }
    pageItems.push(candidate);
  });
  function jump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const target = Math.min(pageCount, Math.max(1, Number(form.get("page")) || 1));
    onPageChange(target);
  }
  return (
    <div className="table-pagination">
      <span>Showing {start}–{end} of {total} {itemLabel}</span>
      <div className="table-pagination-controls">
        <label>Rows <select aria-label={`Rows per page for ${itemLabel}`} value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></label>
        <nav className="pagination-pages" aria-label={`${itemLabel} pages`}>
          <button type="button" onClick={() => onPageChange(1)} disabled={page <= 1} aria-label="First page" title="First page"><ChevronsLeft size={15} /></button>
          <button type="button" onClick={() => onPageChange(page - 1)} disabled={page <= 1} aria-label="Previous page" title="Previous page"><ChevronLeft size={15} /></button>
          {pageItems.map((item) => typeof item === "number"
            ? <button type="button" className={item === page ? "is-current" : ""} aria-current={item === page ? "page" : undefined} onClick={() => onPageChange(item)} key={item}>{item}</button>
            : <span className="pagination-ellipsis" key={item}>…</span>)}
          <button type="button" onClick={() => onPageChange(page + 1)} disabled={page >= pageCount} aria-label="Next page" title="Next page"><ChevronRight size={15} /></button>
          <button type="button" onClick={() => onPageChange(pageCount)} disabled={page >= pageCount} aria-label="Last page" title="Last page"><ChevronsRight size={15} /></button>
        </nav>
        <form className="pagination-jump" onSubmit={jump}>
          <input key={page} name="page" type="number" min="1" max={pageCount} defaultValue={page} aria-label={`Go to ${itemLabel} page`} />
          <span>of {pageCount} pages</span>
          <button type="submit">Go</button>
        </form>
      </div>
    </div>
  );
}

function DiscoverView({ mutateLibrary, notify, onImport }: {
  mutateLibrary: (body: MutationBody, successMessage: string) => Promise<boolean>;
  notify: (message: string, tone?: ToastState["tone"]) => void;
  onImport: () => void;
}) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<DiscoveryProvider>("semantic-scholar");
  const [results, setResults] = useState<DiscoveryResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState<string[]>([]);

  async function search(event?: FormEvent) {
    event?.preventDefault();
    if (!query.trim()) {
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, provider }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = (await response.json()) as { results: DiscoveryResult[] };
      setResults(payload.results);
      if (!payload.results.length) {
        notify("No matching papers found.", "info");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "Discovery search failed.", "error");
    } finally {
      setLoading(false);
    }
  }

  async function addResult(result: DiscoveryResult) {
    const succeeded = await mutateLibrary(
      { entity: "paper", action: "create", data: { ...result } },
      "Paper added to your library.",
    );
    if (succeeded) {
      setAdded([...added, result.sourceId || result.title]);
    }
  }

  return (
    <div className="discover-view">
      <form className="discover-search" onSubmit={search}>
        <div className="provider-switch">
          <span>Search in</span>
          {discoveryProviders.map((item) => (
            <button
              type="button"
              className={provider === item.id ? "is-active" : ""}
              onClick={() => setProvider(item.id)}
              key={item.id}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="discover-search-box">
          <Search size={21} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a topic, title, DOI, or researcher" autoFocus />
          <button type="submit" disabled={loading || !query.trim()}>{loading ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />} Search</button>
        </div>
      </form>

      {!results.length && !loading ? (
        <div className="discovery-intro">
          <div className="discovery-orbit"><span /><span /><span /><Sparkles size={28} /></div>
          <h2>Search beyond your library.</h2>
          <p>PA queries academic sources, preserves identifiers and author order, and normalizes new records as they enter your workspace.</p>
          <div className="prompt-suggestions">
            {["long-context retrieval agents", "human AI literature review", "scholarly knowledge graphs"].map((suggestion) => (
              <button key={suggestion} onClick={() => setQuery(suggestion)}><WandSparkles size={14} />{suggestion}</button>
            ))}
          </div>
          <div className="discovery-capabilities">
            <div><Search size={17} /><span><strong>Search your library</strong><small>Title, abstract, author, venue, notes, filters, and fuzzy matching.</small></span></div>
            <button type="button" onClick={onImport}><Database size={17} /><span><strong>Import by source</strong><small>arXiv, DOI, DBLP, OpenReview, URL/PDF, or manual metadata.</small></span><ArrowRight size={15} /></button>
          </div>
        </div>
      ) : null}

      {loading ? <div className="result-loading"><LoaderCircle className="spin" /><p>Searching {providerLabel(provider)}…</p></div> : null}

      {results.length ? (
        <div className="discovery-results">
          <div className="results-heading"><span>{results.length} results</span><small>from {results[0]?.source}</small></div>
          {results.map((result) => {
            const key = result.sourceId || result.title;
            const isAdded = added.includes(key);
            return (
              <article className="discovery-result" key={key}>
                <span className="result-source-icon"><FileText size={18} /></span>
                <div className="result-copy">
                  <div className="result-meta"><span>{result.source}</span><i />{result.year ?? "Year unknown"}</div>
                  <h3>{result.title}</h3>
                  <p className="result-authors">{result.authors.join(", ") || "Authors unavailable"}</p>
                  <MarkdownContent content={result.abstract || "No abstract is available for this result."} className="result-abstract markdown-compact" />
                  <div className="result-tags"><span>{result.venueName || "Venue unknown"}</span>{result.doi ? <span>DOI {result.doi}</span> : null}{result.pdfUrl ? <span>Open PDF</span> : null}</div>
                </div>
                <button className={isAdded ? "added-button" : "result-add"} disabled={isAdded} onClick={() => void addResult(result)}>
                  {isAdded ? <><Check size={16} /> Added</> : <><Plus size={16} /> Add</>}
                </button>
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function PaperDetail({ paper, onClose, onUpdate, onChat, onRead, onEdit, onDelete, onOpenAuthor, onOpenVenue, onOpenCollection }: {
  paper: Paper;
  onClose: () => void;
  onUpdate: (paper: Paper, data: Record<string, unknown>, message: string) => Promise<void>;
  onChat: () => void;
  onRead: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenAuthor: (authorName: string) => void;
  onOpenVenue: () => void;
  onOpenCollection: (collectionId: string, collectionName: string) => void;
}) {
  const hasViewer = Boolean(paper.pdfUrl || paper.htmlUrl);
  return (
    <div className="drawer-layer">
      <button className="drawer-scrim" onClick={onClose} aria-label="Close paper details" />
      <aside className="detail-drawer" aria-label="Paper details">
        <div className="drawer-header is-minimal">
          <button className="icon-button" onClick={onClose} aria-label="Close"><PanelRightClose size={19} /></button>
        </div>
        <div className="drawer-content">
          <div className="detail-actions-top">
            <StatusPill status={paper.readingStatus} />
            <button className={`star-button ${paper.favorite ? "is-starred" : ""}`} onClick={() => void onUpdate(paper, { favorite: !paper.favorite }, paper.favorite ? "Removed from starred papers." : "Paper starred.")}>
              <Star size={16} fill={paper.favorite ? "currentColor" : "none"} />
            </button>
          </div>
          <h2>{paper.title}</h2>
          <div className="detail-authors" aria-label="Paper authors">
            {paper.authors.length
              ? paper.authors.map((author) => <button type="button" key={author.id} onClick={() => onOpenAuthor(author.displayName)}>{author.displayName}</button>)
              : <span>Authors not recorded</span>}
          </div>
          <div className="detail-meta-grid">
            <span><small>Venue</small><button type="button" className="detail-entity-link" onClick={onOpenVenue} disabled={!paper.venueId && !paper.venueName && !paper.venueAcronym}>{venueLine(paper)}</button></span>
            <span><small>Year</small><strong>{paper.year ?? "—"}</strong></span>
            <span><small>Type</small><strong>{paper.paperType}</strong></span>
          </div>
          <div className="detail-quick-section">
            <div>
              <p className="eyebrow">Reading status</p>
              <div className="status-selector">
                {["inbox", "reading", "complete"].map((status) => (
                  <button key={status} className={paper.readingStatus === status ? "is-active" : ""} onClick={() => void onUpdate(paper, { readingStatus: status }, `Marked as ${statusLabel(status).toLowerCase()}.`)}>{statusLabel(status)}</button>
                ))}
              </div>
            </div>
            <div>
              <p className="eyebrow">Collections</p>
              <div className="collection-chips large-chips">{paper.collections.length ? paper.collections.map((collection) => <button type="button" key={collection.id} className="collection-chip" onClick={() => onOpenCollection(collection.id, collection.name)}>{collection.name}</button>) : <span className="row-muted">No collections yet</span>}</div>
            </div>
          </div>
          <div className="drawer-cta-row">
            {hasViewer ? <button className="primary-action" onClick={onRead}><BookOpen size={16} /> Read</button> : null}
            {paper.url ? <a className="secondary-action" href={paper.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Source</a> : null}
            <button className="secondary-action" onClick={onChat}><Sparkles size={16} /> Ask PA</button>
            <button className="secondary-action" onClick={onEdit}><Pencil size={15} /> Edit</button>
          </div>
          <div className="detail-section summary-section">
            <p className="eyebrow">PA summary</p>
            {paper.summary ? <MarkdownContent content={paper.summary} className="summary-copy" /> : <p className="summary-empty">No summary yet. PA can ground one in the paper’s source and metadata.</p>}
          </div>
          <div className="detail-section">
            <p className="eyebrow">Abstract</p>
            <MarkdownContent content={paper.abstract || "No abstract is recorded for this paper."} className="abstract-copy" />
          </div>
          <div className="detail-section">
            <p className="eyebrow">Research notes</p>
            <textarea
              defaultValue={paper.notes}
              placeholder="Add an observation, question, or connection…"
              onBlur={(event) => {
                if (event.target.value !== paper.notes) {
                  void onUpdate(paper, { notes: event.target.value }, "Notes saved.");
                }
              }}
            />
          </div>
          {paper.volume || paper.issue || paper.pages || paper.category || paper.doi || paper.preprintId || paper.arxivId || paper.localPath || paper.htmlSnapshotPath ? (
            <div className="detail-section">
              <p className="eyebrow">Publication details</p>
              <div className="identifier-list publication-detail-list">
                {paper.volume ? <span><b>Volume</b>{paper.volume}</span> : null}
                {paper.issue ? <span><b>Issue</b>{paper.issue}</span> : null}
                {paper.pages ? <span><b>Pages</b>{paper.pages}</span> : null}
                {paper.category ? <span><b>Category</b>{paper.category}</span> : null}
                {paper.doi ? <span><b>DOI</b>{paper.doi}</span> : null}
                {paper.preprintId || paper.arxivId ? <span><b>Preprint</b>{paper.preprintId || paper.arxivId}</span> : null}
                {paper.localPath ? <span><b>File</b>{paper.localPath}</span> : null}
                {paper.htmlSnapshotPath ? <span><b>HTML</b>{paper.htmlSnapshotPath}</span> : null}
              </div>
            </div>
          ) : null}
        </div>
        <div className="drawer-footer"><span>Added {formatDate(paper.addedAt)}</span><button className="danger-text" onClick={onDelete}><Trash2 size={14} /> Delete paper</button></div>
      </aside>
    </div>
  );
}

function ReaderDrawer({ paper, onClose, onChat }: {
  paper: Paper;
  onClose: () => void;
  onChat: () => void;
}) {
  const viewerUrl = paper.htmlUrl || paper.pdfUrl;
  const isHtml = Boolean(paper.htmlUrl);
  return (
    <div className="reader-layer">
      <header className="reader-header">
        <div className="reader-brand"><span className="brand-mark">PA</span><span><small>{isHtml ? "HTML snapshot" : "PDF reader"}</small><strong>{paper.title}</strong></span></div>
        <div className="reader-actions">
          <button onClick={onChat}><Sparkles size={15} /> Ask PA</button>
          {paper.url ? <a href={paper.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Source</a> : null}
          <button className="reader-close" onClick={onClose} aria-label="Close reader"><X size={18} /></button>
        </div>
      </header>
      <div className="reader-workspace">
        <main className="reader-document">
          {viewerUrl ? (
            isHtml ? (
              <iframe src={viewerUrl} title={`HTML snapshot of ${paper.title}`} sandbox="" />
            ) : (
              <iframe src={viewerUrl} title={`PDF of ${paper.title}`} />
            )
          ) : (
            <EmptyState icon={<FileText size={24} />} title="No local document" detail="This record does not have a stored PDF or HTML snapshot." />
          )}
        </main>
        <aside className="reader-notes">
          <div className="reader-paper-meta"><StatusPill status={paper.readingStatus} /><span>{venueLine(paper)} · {paper.year ?? "n.d."}</span></div>
          <h2>{paper.title}</h2>
          <p className="reader-authors">
            {paper.authors.length
              ? paper.authors.map((author) => author.displayName).join(", ")
              : "Authors not recorded"}
          </p>
          <div className="reader-summary">
            <p className="eyebrow">Summary</p>
            <MarkdownContent content={paper.summary || paper.abstract || "No summary is available for this paper yet."} />
          </div>
          <div className="reader-summary">
            <p className="eyebrow">My notes</p>
            <MarkdownContent content={paper.notes || "Open paper details to add research notes."} />
          </div>
          <button className="reader-chat-button" onClick={onChat}><Sparkles size={15} /> Discuss this paper with PA</button>
        </aside>
      </div>
    </div>
  );
}

function ChatDrawer({ paper, papers, onClose }: { paper: Paper; papers: Paper[]; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "welcome", role: "assistant", content: `I’m ready to think through “${paper.title}” with you. Ask about the argument, methods, connections, or next steps.` },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [paperPickerOpen, setPaperPickerOpen] = useState(false);
  const [paperQuery, setPaperQuery] = useState("");
  const [selectedPaperIds, setSelectedPaperIds] = useState<string[]>([paper.id]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const { runTask } = useBackgroundTasks();

  const selectedDiscussionPapers = papers.filter((item) => selectedPaperIds.includes(item.id));
  const availableDiscussionPapers = papers.filter((item) => matchesSearch([
    item.title,
    authorLine(item),
    venueLine(item),
    item.year,
  ], paperQuery));

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function toggleDiscussionPaper(paperId: string) {
    setSelectedPaperIds((current) => {
      if (current.includes(paperId)) {
        return current.length === 1 ? current : current.filter((id) => id !== paperId);
      }
      return [...current, paperId].slice(-8);
    });
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const content = input.trim();
    if (!content || loading) {
      return;
    }
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    try {
      const payload = await runTask(`Ask PA · ${selectedDiscussionPapers.length} ${selectedDiscussionPapers.length === 1 ? "paper" : "papers"}`, async () => {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: nextMessages.filter((message) => message.id !== "welcome").map(({ role, content: messageContent }) => ({ role, content: messageContent })),
            papers: selectedDiscussionPapers.map((selected) => ({
              title: selected.title,
              abstract: selected.abstract,
              summary: selected.summary,
              notes: selected.notes,
              authors: selected.authors.map((author) => author.displayName),
              venue: venueLine(selected),
              year: selected.year,
            })),
          }),
        });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
        return response.json() as Promise<{ content: string }>;
      });
      setMessages([...nextMessages, { id: crypto.randomUUID(), role: "assistant", content: payload.content }]);
    } catch (error) {
      setMessages([...nextMessages, { id: crypto.randomUUID(), role: "assistant", content: error instanceof Error ? `I couldn’t complete that request: ${error.message}` : "I couldn’t complete that request." }]);
    } finally {
      setLoading(false);
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  return (
    <div className="drawer-layer chat-layer">
      <button className="drawer-scrim" onClick={onClose} aria-label="Close assistant" />
      <aside className="chat-drawer">
        <div className="chat-header">
          <span className="assistant-orb large"><Sparkles size={19} /></span>
          <span><strong>Ask PA</strong><small>Grounded in the selected paper</small></span>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="chat-context-wrap">
          <div className="chat-context">
            <FileText size={15} />
            <span><small>Discussing {selectedDiscussionPapers.length} {selectedDiscussionPapers.length === 1 ? "paper" : "papers"}</small><strong>{selectedDiscussionPapers.map((selected) => selected.title).join(" · ")}</strong></span>
            <button type="button" className="chat-context-add" onClick={() => setPaperPickerOpen((current) => !current)} aria-expanded={paperPickerOpen}><Plus size={13} /> Select papers</button>
          </div>
          {paperPickerOpen ? (
            <div className="chat-paper-picker">
              <label><Search size={14} /><input value={paperQuery} onChange={(event) => setPaperQuery(event.target.value)} placeholder="Find a paper in your library" autoFocus /></label>
              <div className="chat-paper-options">
                {availableDiscussionPapers.map((item) => {
                  const selected = selectedPaperIds.includes(item.id);
                  const onlySelected = selected && selectedPaperIds.length === 1;
                  return <button type="button" className={selected ? "is-selected" : ""} onClick={() => toggleDiscussionPaper(item.id)} disabled={onlySelected} key={item.id}><span className="selection-box">{selected ? <Check size={11} /> : null}</span><span><strong>{item.title}</strong><small>{fullAuthorLine(item)} · {item.year ?? "n.d."}</small></span></button>;
                })}
              </div>
              <div className="chat-paper-picker-footer"><span>Up to 8 papers can ground one discussion.</span><button type="button" onClick={() => setPaperPickerOpen(false)}>Done</button></div>
            </div>
          ) : null}
        </div>
        <div className="chat-messages">
          {messages.map((message) => (
            <div className={`chat-message message-${message.role}`} key={message.id}>
              {message.role === "assistant" ? <span className="message-avatar"><Sparkles size={13} /></span> : null}
              <MarkdownContent content={message.content} className="chat-bubble" />
            </div>
          ))}
          {loading ? <div className="chat-message message-assistant"><span className="message-avatar"><Sparkles size={13} /></span><p className="typing"><i /><i /><i /></p></div> : null}
          <div ref={bottomRef} />
        </div>
        <div className="chat-prompts">
          {["Summarize the contribution", "Challenge the methods", "Connect to my notes"].map((prompt) => <button key={prompt} onClick={() => setInput(prompt)}>{prompt}</button>)}
        </div>
        <form className="chat-composer" onSubmit={sendMessage}>
          <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onComposerKeyDown} placeholder="Ask about this paper…" rows={2} />
          <button type="submit" disabled={!input.trim() || loading} aria-label="Send message"><Send size={17} /></button>
          <small>Enter to send · Shift + Enter for a new line</small>
        </form>
      </aside>
    </div>
  );
}

function ModalFrame({ title, subtitle, onClose, children, className = "" }: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="modal-layer">
      <button className="modal-scrim" onClick={onClose} aria-label="Close dialog" />
      <section className={`modal-card ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div>
        {children}
      </section>
    </div>
  );
}

function LocalFileField({ name, label, kind, defaultValue = "", notify }: {
  name: "localPath" | "htmlSnapshotPath";
  label: string;
  kind: "pdf" | "html";
  defaultValue?: string;
  notify: (message: string, tone?: ToastState["tone"]) => void;
}) {
  const pathInput = useRef<HTMLInputElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const { runTask } = useBackgroundTasks();

  async function loadLocalFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setUploading(true);
    try {
      const payload = await runTask(`Copy ${file.name} into PA storage`, async () => {
        const response = await fetch("/api/local-file-import", {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-PA-File-Kind": kind,
            "X-PA-File-Name": encodeURIComponent(file.name),
          },
          body: file,
        });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
        return response.json() as Promise<{ storedPath: string }>;
      });
      if (pathInput.current) {
        pathInput.current.value = payload.storedPath;
      }
      notify(`${file.name} copied into PA’s local ${kind === "pdf" ? "PDF" : "HTML snapshot"} storage.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "The local file could not be loaded.", "error");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  return (
    <label className="field-span-2 local-file-field">
      <span>{label}</span>
      <div className="local-file-control">
        <input ref={pathInput} name={name} defaultValue={defaultValue} placeholder={kind === "pdf" ? "paper.pdf" : "paper.html"} />
        <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading} aria-label={`Choose local ${kind === "pdf" ? "PDF" : "HTML"} file`} title="Choose from local files">
          {uploading ? <LoaderCircle size={17} className="spin" /> : <FolderOpen size={17} />}
        </button>
        <input
          ref={fileInput}
          className="local-file-picker"
          type="file"
          accept={kind === "pdf" ? ".pdf,application/pdf" : ".html,.htm,text/html"}
          onChange={(event) => void loadLocalFile(event)}
          tabIndex={-1}
        />
      </div>
      <small>Choose a local file to copy it into PA storage and save its portable relative location.</small>
    </label>
  );
}

function PaperMetadataFields({ paperType, paper, notify }: {
  paperType: EditablePaperType;
  paper?: Paper;
  notify: (message: string, tone?: ToastState["tone"]) => void;
}) {
  const visible = metadataVisibility(paperType);
  const venueLabel = paperType === "preprint" ? "Website / archive" : "Full venue name";
  return (
    <>
      {visible.venueName ? <label><span>{venueLabel}</span><input name="venueName" defaultValue={paper?.venueName ?? ""} placeholder={paperType === "preprint" ? "arXiv" : "Neural Information Processing Systems"} /></label> : null}
      {visible.venueAcronym ? <label><span>Venue acronym</span><input name="venueAcronym" defaultValue={paper?.venueAcronym ?? ""} placeholder="NeurIPS" /></label> : null}
      {visible.volumeIssue ? <label><span>Volume</span><input name="volume" defaultValue={paper?.volume ?? ""} placeholder="42" /></label> : null}
      {visible.volumeIssue ? <label><span>Issue</span><input name="issue" defaultValue={paper?.issue ?? ""} placeholder="3" /></label> : null}
      {visible.pages ? <label><span>Pages</span><input name="pages" defaultValue={paper?.pages ?? ""} placeholder="101–118" /></label> : null}
      {visible.preprint ? <label><span>Category</span><input name="category" defaultValue={paper?.category ?? ""} placeholder="cs.CL" /></label> : null}
      {visible.preprint ? <label><span>Preprint ID</span><input name="preprintId" defaultValue={paper?.preprintId ?? paper?.arxivId ?? ""} placeholder="arXiv:2607.01234" /></label> : null}
      {visible.doi ? <label><span>DOI</span><input name="doi" defaultValue={paper?.doi ?? ""} placeholder="10.1000/xyz123" /></label> : null}
      {visible.url ? <label className="field-span-2"><span>Source URL</span><input name="url" type="url" defaultValue={paper?.url ?? ""} placeholder="https://…" /></label> : null}
      {visible.pdf ? <LocalFileField name="localPath" label="Local PDF path" kind="pdf" defaultValue={paper?.localPath ?? ""} notify={notify} /> : null}
      {visible.html ? <LocalFileField name="htmlSnapshotPath" label="Local HTML snapshot path" kind="html" defaultValue={paper?.htmlSnapshotPath ?? ""} notify={notify} /> : null}
    </>
  );
}

function AddPaperModal({ onClose, mutateLibrary, notify }: {
  onClose: () => void;
  mutateLibrary: (body: MutationBody, successMessage: string) => Promise<boolean>;
  notify: (message: string, tone?: ToastState["tone"]) => void;
}) {
  const [tab, setTab] = useState<"search" | "identifier" | "bibliography" | "url" | "manual">("search");
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<DiscoveryProvider>("semantic-scholar");
  const [identifierSource, setIdentifierSource] = useState<IdentifierSource>("arxiv");
  const [identifier, setIdentifier] = useState("");
  const [bibliographyFile, setBibliographyFile] = useState<File | null>(null);
  const [results, setResults] = useState<DiscoveryResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const [manualPaperType, setManualPaperType] = useState<EditablePaperType>("conference");
  const { runTask } = useBackgroundTasks();

  async function searchPapers(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) {
      return;
    }
    setLoading(true);
    try {
      const payload = await runTask(`Search ${discoveryProviders.find((item) => item.id === provider)?.label ?? "academic sources"}`, async () => {
        const response = await fetch("/api/discover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, provider }) });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
        return response.json() as Promise<{ results: DiscoveryResult[] }>;
      });
      setResults(payload.results);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Search failed.", "error");
    } finally {
      setLoading(false);
    }
  }

  async function addResult(result: DiscoveryResult) {
    const succeeded = await mutateLibrary({ entity: "paper", action: "create", data: { ...result } }, "Paper added to your library.");
    if (succeeded) {
      setAdded([...added, result.sourceId || result.title]);
    }
  }

  async function importUrl(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const succeeded = await runTask("Import web source and acquire content", async () => {
        const response = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
        const result = (await response.json()) as Record<string, unknown>;
        const imported = await mutateLibrary({ entity: "paper", action: "create", data: { ...result, authors: [] } }, "Page imported with Jina Reader.");
        if (!imported) {
          throw new Error("The imported source could not be saved.");
        }
        return imported;
      });
      if (succeeded) {
        onClose();
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "URL import failed.", "error");
    } finally {
      setLoading(false);
    }
  }

  async function importByIdentifier(event: FormEvent) {
    event.preventDefault();
    if (!identifier.trim()) {
      return;
    }
    setLoading(true);
    try {
      const sourceLabel = identifierSources.find((source) => source.id === identifierSource)?.label ?? "Source";
      const succeeded = await runTask(`Resolve and import ${sourceLabel}`, async () => {
        const response = await fetch("/api/import-identifier", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: identifierSource, identifier }),
        });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
        const payload = await response.json() as { paper: DiscoveryResult };
        const imported = await mutateLibrary(
          { entity: "paper", action: "create", data: { ...payload.paper } },
          `${sourceLabel} paper imported.`,
        );
        if (!imported) {
          throw new Error("The resolved paper could not be saved.");
        }
        return imported;
      });
      if (succeeded) {
        onClose();
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "Identifier import failed.", "error");
    } finally {
      setLoading(false);
    }
  }

  async function importBibliography(event: FormEvent) {
    event.preventDefault();
    if (!bibliographyFile) {
      return;
    }
    const filename = bibliographyFile.name.toLowerCase();
    const format = filename.endsWith(".ris") || filename.endsWith(".txt") ? "ris" : "bibtex";
    setLoading(true);
    try {
      const succeeded = await runTask(`Import ${bibliographyFile.name}`, async () => {
        const response = await fetch("/api/import-bibliography", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format, content: await bibliographyFile.text() }),
        });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
        const payload = await response.json() as { papers: Array<Record<string, unknown>> };
        const imported = await mutateLibrary(
          { entity: "paper", action: "bulk-create", data: { papers: payload.papers } },
          `${payload.papers.length} ${format === "bibtex" ? "BibTeX" : "RIS"} ${payload.papers.length === 1 ? "record" : "records"} imported.`,
        );
        if (!imported) {
          throw new Error("The bibliography records could not be saved.");
        }
        return imported;
      });
      if (succeeded) {
        onClose();
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "Bibliography import failed.", "error");
    } finally {
      setLoading(false);
    }
  }

  async function addManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const visible = metadataVisibility(manualPaperType);
    const succeeded = await mutateLibrary(
      {
        entity: "paper",
        action: "create",
        data: {
          title: form.get("title"),
          authors: String(form.get("authors") ?? "").split(",").map((name) => name.trim()).filter(Boolean),
          year: form.get("year"),
          paperType: manualPaperType,
          ...(visible.venueName ? { venueName: form.get("venueName") } : {}),
          ...(visible.venueAcronym ? { venueAcronym: form.get("venueAcronym") } : {}),
          ...(visible.volumeIssue ? { volume: form.get("volume"), issue: form.get("issue") } : {}),
          ...(visible.pages ? { pages: form.get("pages") } : {}),
          ...(visible.preprint ? { category: form.get("category"), preprintId: form.get("preprintId") } : {}),
          ...(visible.doi ? { doi: form.get("doi") } : {}),
          ...(visible.url ? { url: form.get("url") } : {}),
          ...(visible.pdf ? { localPath: form.get("localPath") } : {}),
          ...(visible.html ? { htmlSnapshotPath: form.get("htmlSnapshotPath") } : {}),
          abstract: form.get("abstract"),
          summary: form.get("summary"),
          notes: form.get("notes"),
          readingStatus: "inbox",
        },
      },
      "Paper added to your library.",
    );
    if (succeeded) {
      onClose();
    }
  }

  return (
    <ModalFrame title="Add to Paper Assistant" subtitle="Search academic sources, import bibliography files, or enter metadata yourself." onClose={onClose} className="add-modal">
      <div className="modal-tabs">
        <button aria-pressed={tab === "search"} className={tab === "search" ? "is-active" : ""} onClick={() => setTab("search")}><Search size={15} /> Academic search</button>
        <button aria-pressed={tab === "identifier"} className={tab === "identifier" ? "is-active" : ""} onClick={() => setTab("identifier")}><Database size={15} /> Identifier</button>
        <button aria-pressed={tab === "bibliography"} className={tab === "bibliography" ? "is-active" : ""} onClick={() => setTab("bibliography")}><Upload size={15} /> BibTeX / RIS</button>
        <button aria-pressed={tab === "url"} className={tab === "url" ? "is-active" : ""} onClick={() => setTab("url")}><Link2 size={15} /> URL / PDF link</button>
        <button aria-pressed={tab === "manual"} className={tab === "manual" ? "is-active" : ""} onClick={() => setTab("manual")}><Pencil size={15} /> Manual</button>
      </div>
      {tab === "search" ? (
        <div className="modal-body">
          <form className="modal-search-row" onSubmit={searchPapers}>
            <label><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Paper title, DOI, author, or topic" autoFocus /></label>
            <button className="primary-action" disabled={loading || !query.trim()}>{loading ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />} Search</button>
          </form>
          <div className="source-row">
            <span>Search in</span>
            {discoveryProviders.map((item) => <button type="button" className={provider === item.id ? "is-active" : ""} onClick={() => setProvider(item.id)} key={item.id}>{item.label}</button>)}
          </div>
          {!results.length && !loading ? <div className="modal-placeholder"><span><Compass size={22} /></span><h3>Find a paper anywhere.</h3><p>PA will preserve authors, identifiers, venue metadata, and open-access links.</p></div> : null}
          <div className="modal-results">
            {results.map((result) => {
              const key = result.sourceId || result.title;
              const isAdded = added.includes(key);
              return <article key={key}><div><small>{result.source} · {result.year ?? "n.d."}</small><h3>{result.title}</h3><p>{result.authors.join(", ") || "Authors unavailable"}</p><span>{result.venueName || "Venue unknown"}</span></div><button disabled={isAdded} onClick={() => void addResult(result)}>{isAdded ? <><Check size={15} /> Added</> : <><Plus size={15} /> Add</>}</button></article>;
            })}
          </div>
        </div>
      ) : tab === "identifier" ? (
        <form className="modal-body identifier-import-form" onSubmit={importByIdentifier}>
          <div className="identifier-source-grid">
            {identifierSources.map((source) => (
              <button type="button" aria-pressed={identifierSource === source.id} className={identifierSource === source.id ? "is-active" : ""} onClick={() => { setIdentifierSource(source.id); setIdentifier(""); }} key={source.id}>
                <Database size={16} />
                <span><strong>{source.label}</strong><small>{source.hint}</small></span>
                {identifierSource === source.id ? <Check className="selected-option-check" size={15} /> : null}
              </button>
            ))}
          </div>
          <label className="large-field">
            <Link2 size={17} />
            <input
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder={identifierSources.find((source) => source.id === identifierSource)?.placeholder}
              required
              autoFocus
            />
          </label>
          <button className="primary-action full-action" disabled={loading || !identifier.trim()}>{loading ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />} Resolve and import</button>
          <p className="identifier-footnote">Identifier imports resolve one canonical record. Use BibTeX / RIS for batch bibliography files.</p>
        </form>
      ) : tab === "bibliography" ? (
        <form className="modal-body bibliography-import-form" onSubmit={importBibliography}>
          <label className={`bibliography-dropzone ${bibliographyFile ? "has-file" : ""}`}>
            <span className="bibliography-upload-icon">{bibliographyFile ? <Check size={23} /> : <Upload size={23} />}</span>
            <span><strong>{bibliographyFile?.name ?? "Choose a BibTeX or RIS file"}</strong><small>{bibliographyFile ? `${Math.max(1, Math.round(bibliographyFile.size / 1024))} KB · ready to import` : ".bib, .bibtex, .ris, or RIS-formatted .txt · up to 5 MB"}</small></span>
            <input
              type="file"
              accept=".bib,.bibtex,.ris,.txt,application/x-bibtex,application/x-research-info-systems"
              onChange={(event: ChangeEvent<HTMLInputElement>) => setBibliographyFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <div className="bibliography-format-notes">
            <div><strong>BibTeX</strong><small>Imports title, ordered authors, year, venue, DOI, URL, volume, issue, pages, and ePrint ID.</small></div>
            <div><strong>RIS</strong><small>Imports journal or conference metadata, ordered authors, DOI, URL, and page range.</small></div>
          </div>
          <button className="primary-action full-action" disabled={loading || !bibliographyFile}>{loading ? <LoaderCircle size={16} className="spin" /> : <Upload size={16} />} Import bibliography</button>
          <p className="identifier-footnote">Every valid record is normalized into PA’s library with linked author and venue records.</p>
        </form>
      ) : tab === "url" ? (
        <form className="modal-body import-form" onSubmit={importUrl}>
          <div className="import-illustration"><Upload size={28} /><span /></div>
          <h3>Import from the web</h3>
          <p>Paste a public article, arXiv, publisher, or PDF URL. Jina Reader extracts clean content and metadata for PA.</p>
          <label className="large-field"><Link2 size={17} /><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://arxiv.org/abs/…" required autoFocus /></label>
          <button className="primary-action full-action" disabled={loading || !url.trim()}>{loading ? <LoaderCircle size={16} className="spin" /> : <WandSparkles size={16} />} Read and import</button>
          <small className="privacy-note">Only the URL is sent to Jina Reader. Your local notes stay in PA.</small>
        </form>
      ) : (
        <form className="modal-body entity-form" onSubmit={addManual}>
          <label className="field-span-2"><span>Paper title *</span><input name="title" required autoFocus placeholder="A precise, complete title" /></label>
          <label className="field-span-2"><span>Authors</span><input name="authors" placeholder="Amina Rahman, Theo Martins" /><small>Separate author names with commas. Each becomes a linked author record.</small></label>
          <label><span>Year</span><input name="year" type="number" min="1500" max="2200" placeholder="2026" /></label>
          <label><span>Paper type</span><select name="paperType" value={manualPaperType} onChange={(event) => setManualPaperType(event.target.value as EditablePaperType)}>{paperTypeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
          <PaperMetadataFields paperType={manualPaperType} notify={notify} />
          <label className="field-span-2"><span>Abstract</span><textarea name="abstract" rows={5} placeholder="What this paper contributes…" /></label>
          <label className="field-span-2"><span>Summary</span><textarea name="summary" rows={4} placeholder="A compact synthesis for your library…" /></label>
          <label className="field-span-2"><span>Research notes</span><textarea name="notes" rows={3} placeholder="Observations, questions, and connections…" /></label>
          <div className="form-actions field-span-2"><button type="button" className="secondary-action modal-action-icon" onClick={onClose} aria-label="Cancel" title="Cancel"><X size={17} /></button><button className="primary-action modal-action-icon" aria-label="Add paper" title="Add paper"><Plus size={17} /></button></div>
        </form>
      )}
    </ModalFrame>
  );
}

function PaperEditModal({ paper, onClose, mutateLibrary, notify }: {
  paper: Paper;
  onClose: () => void;
  mutateLibrary: (body: MutationBody, successMessage: string) => Promise<boolean>;
  notify: (message: string, tone?: ToastState["tone"]) => void;
}) {
  const [paperType, setPaperType] = useState<EditablePaperType>(() => editablePaperType(paper.paperType));
  const [summary, setSummary] = useState(paper.summary);
  const [summarizing, setSummarizing] = useState(false);
  const { runTask } = useBackgroundTasks();

  async function generateSummary() {
    setSummarizing(true);
    try {
      const payload = await runTask(`Generate summary · ${paper.title}`, async () => {
        const response = await fetch("/api/summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paper: {
              title: paper.title,
              abstract: paper.abstract,
              authors: paper.authors.map((author) => author.displayName),
              venue: venueLine(paper),
              year: paper.year,
              url: paper.url,
              doi: paper.doi,
            },
          }),
        });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
        return response.json() as Promise<{ summary: string }>;
      });
      setSummary(payload.summary);
      notify("Summary generated. Save the paper to keep it.", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Summary generation failed.", "error");
    } finally {
      setSummarizing(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const visible = metadataVisibility(paperType);
    const succeeded = await mutateLibrary(
      {
        entity: "paper",
        action: "update",
        id: paper.id,
        data: {
          title: form.get("title"),
          authors: String(form.get("authors") ?? "").split(",").map((name) => name.trim()).filter(Boolean),
          year: form.get("year"),
          paperType,
          ...(visible.venueName ? { venueName: form.get("venueName") } : {}),
          ...(visible.venueAcronym ? { venueAcronym: form.get("venueAcronym") } : {}),
          ...(visible.volumeIssue ? { volume: form.get("volume"), issue: form.get("issue") } : {}),
          ...(visible.pages ? { pages: form.get("pages") } : {}),
          ...(visible.preprint ? { category: form.get("category"), preprintId: form.get("preprintId") } : {}),
          ...(visible.doi ? { doi: form.get("doi") } : {}),
          ...(visible.url ? { url: form.get("url") } : {}),
          ...(visible.pdf ? { localPath: form.get("localPath") } : {}),
          ...(visible.html ? { htmlSnapshotPath: form.get("htmlSnapshotPath") } : {}),
          abstract: form.get("abstract"),
          summary,
          notes: form.get("notes"),
        },
      },
      "Paper metadata updated across the library.",
    );
    if (succeeded) {
      onClose();
    }
  }

  return (
    <ModalFrame title="Edit paper" subtitle="Update the complete PA record, linked authors, venue, files, summary, and notes." onClose={onClose} className="add-modal">
      <form className="modal-body entity-form" onSubmit={submit}>
        <label className="field-span-2"><span>Paper title *</span><input name="title" required defaultValue={paper.title} autoFocus /></label>
        <label><span>Year</span><input name="year" type="number" min="1500" max="2200" defaultValue={paper.year ?? ""} /></label>
        <label><span>Paper type</span><select name="paperType" value={paperType} onChange={(event) => setPaperType(event.target.value as EditablePaperType)}>{paperTypeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
        <label className="field-span-2"><span>Authors</span><input name="authors" defaultValue={paper.authors.map((author) => author.displayName).join(", ")} /><small>Comma-separated. Renaming a canonical author from the Authors view updates every linked paper.</small></label>
        <PaperMetadataFields paperType={paperType} paper={paper} notify={notify} />
        <label className="field-span-2 summary-field"><span className="field-label-action"><span>PA summary</span><button type="button" onClick={() => void generateSummary()} disabled={summarizing}>{summarizing ? <LoaderCircle className="spin" size={14} /> : <WandSparkles size={14} />}{paper.summary || summary ? "Regenerate" : "Generate"}</button></span><textarea name="summary" rows={5} value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
        <label className="field-span-2"><span>Abstract</span><textarea name="abstract" rows={5} defaultValue={paper.abstract} /></label>
        <label className="field-span-2"><span>Research notes</span><textarea name="notes" rows={4} defaultValue={paper.notes} /></label>
        <div className="form-actions field-span-2"><button type="button" className="secondary-action modal-action-icon" onClick={onClose} aria-label="Cancel" title="Cancel"><X size={17} /></button><button className="primary-action modal-action-icon" aria-label="Save paper" title="Save paper"><Save size={17} /></button></div>
      </form>
    </ModalFrame>
  );
}

function EntityModal({ entity, record, papers, onClose, mutateLibrary }: {
  entity: "author" | "venue" | "collection";
  record?: Author | Venue | Collection;
  papers: Paper[];
  onClose: () => void;
  mutateLibrary: (body: MutationBody, successMessage: string) => Promise<boolean>;
}) {
  const editing = Boolean(record);
  const title = `${editing ? "Edit" : "New"} ${entity}`;
  const [collectionPaperQuery, setCollectionPaperQuery] = useState("");
  const [availablePaperQuery, setAvailablePaperQuery] = useState("");
  const [collectionPaperPage, setCollectionPaperPage] = useState(1);
  const [availablePaperPage, setAvailablePaperPage] = useState(1);
  const [selectedCollectionPaperId, setSelectedCollectionPaperId] = useState<string | null>(null);
  const [selectedAvailablePaperId, setSelectedAvailablePaperId] = useState<string | null>(null);
  const initialCollectionPaperIds = useMemo(() => {
    if (entity !== "collection" || !record) {
      return [];
    }
    return papers
      .filter((paper) => paper.collections.some((collection) => collection.id === record.id))
      .map((paper) => paper.id);
  }, [entity, papers, record]);
  const [collectionPaperIds, setCollectionPaperIds] = useState<string[]>(() => {
    if (entity !== "collection" || !record) {
      return [];
    }
    return papers
      .filter((paper) => paper.collections.some((collection) => collection.id === record.id))
      .map((paper) => paper.id);
  });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data: Record<string, unknown> = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (entity === "collection") {
      data.paperIds = collectionPaperIds;
    }
    const succeeded = await mutateLibrary(
      { entity, action: editing ? "update" : "create", id: record?.id, data },
      `${entity[0].toUpperCase()}${entity.slice(1)} ${editing ? "updated" : "created"}.`,
    );
    if (succeeded) {
      onClose();
    }
  }
  const author = entity === "author" ? (record as Author | undefined) : undefined;
  const venue = entity === "venue" ? (record as Venue | undefined) : undefined;
  const collection = entity === "collection" ? (record as Collection | undefined) : undefined;
  const papersInCollection = entity === "collection" ? papers
    .filter((paper) => collectionPaperIds.includes(paper.id))
    .filter((paper) => matchesSearch([paper.title, authorLine(paper), venueLine(paper)], collectionPaperQuery)) : [];
  const papersOutsideCollection = entity === "collection" ? papers
    .filter((paper) => !collectionPaperIds.includes(paper.id))
    .filter((paper) => matchesSearch([paper.title, authorLine(paper), venueLine(paper)], availablePaperQuery)) : [];
  const transferPageSize = 10;
  const collectionPageCount = Math.max(1, Math.ceil(papersInCollection.length / transferPageSize));
  const availablePageCount = Math.max(1, Math.ceil(papersOutsideCollection.length / transferPageSize));
  const currentCollectionPage = Math.min(collectionPaperPage, collectionPageCount);
  const currentAvailablePage = Math.min(availablePaperPage, availablePageCount);
  const pagedCollectionPapers = papersInCollection.slice((currentCollectionPage - 1) * transferPageSize, currentCollectionPage * transferPageSize);
  const pagedAvailablePapers = papersOutsideCollection.slice((currentAvailablePage - 1) * transferPageSize, currentAvailablePage * transferPageSize);
  const selectedTransferPaper = papers.find((paper) => paper.id === (selectedCollectionPaperId ?? selectedAvailablePaperId));
  function addSelectedPaperToCollection() {
    if (!selectedAvailablePaperId) {
      return;
    }
    setCollectionPaperIds((current) => Array.from(new Set([...current, selectedAvailablePaperId])));
    setSelectedCollectionPaperId(selectedAvailablePaperId);
    setSelectedAvailablePaperId(null);
  }
  function removeSelectedPaperFromCollection() {
    if (!selectedCollectionPaperId) {
      return;
    }
    setCollectionPaperIds((current) => current.filter((id) => id !== selectedCollectionPaperId));
    setSelectedAvailablePaperId(selectedCollectionPaperId);
    setSelectedCollectionPaperId(null);
  }
  return (
    <ModalFrame title={title} subtitle={entity === "author" ? "Changes propagate to every linked paper." : entity === "venue" ? "Keep publication metadata consistent across your library." : "Move papers between this collection and the rest of your library."} onClose={onClose} className={entity === "collection" ? "collection-manager-modal" : undefined}>
      <form className="modal-body entity-form" onSubmit={submit}>
        {entity === "author" ? <>
          <label className="field-span-2"><span>Display name *</span><input name="displayName" defaultValue={author?.displayName} required autoFocus /></label>
          <label><span>Given name</span><input name="givenName" defaultValue={author?.givenName ?? ""} /></label>
          <label><span>Family name</span><input name="familyName" defaultValue={author?.familyName ?? ""} /></label>
          <label className="field-span-2"><span>Notes</span><textarea name="notes" rows={3} defaultValue={author?.notes ?? ""} /></label>
        </> : entity === "venue" ? <>
          <label className="field-span-2"><span>Full venue name *</span><input name="name" defaultValue={venue?.name} required autoFocus /></label>
          <label><span>Acronym</span><input name="acronym" defaultValue={venue?.acronym ?? ""} placeholder="NeurIPS" /></label>
          <label><span>Type</span><select name="type" defaultValue={venue?.type ?? "conference"}><option value="conference">Conference</option><option value="journal">Journal</option><option value="workshop">Workshop</option><option value="preprint">Preprint archive</option><option value="book">Book / proceedings</option><option value="other">Other</option></select></label>
          <label className="field-span-2"><span>Publisher or society</span><input name="publisher" defaultValue={venue?.publisher ?? ""} /></label>
          <label className="field-span-2"><span>Website</span><input name="url" type="url" defaultValue={venue?.url ?? ""} /></label>
          <label className="field-span-2"><span>Notes</span><textarea name="notes" rows={3} defaultValue={venue?.notes ?? ""} /></label>
        </> : <>
          <label className="field-span-2"><span>Collection name *</span><input name="name" defaultValue={collection?.name} required autoFocus /></label>
          <section className="collection-transfer field-span-2">
            <div className="collection-transfer-grid">
              <div className="transfer-column">
                <header><strong>Papers in collection</strong><small>{collectionPaperIds.length}</small></header>
                <PageSearch value={collectionPaperQuery} onChange={(value) => { setCollectionPaperQuery(value); setCollectionPaperPage(1); }} placeholder="Search collection…" />
                <div className="transfer-paper-list" role="listbox" aria-label="Papers in collection">
                  {pagedCollectionPapers.map((paper) => <button type="button" role="option" aria-selected={selectedCollectionPaperId === paper.id} className={`${selectedCollectionPaperId === paper.id ? "is-selected" : ""} ${!initialCollectionPaperIds.includes(paper.id) ? "is-changed" : ""}`} onClick={() => { setSelectedCollectionPaperId(paper.id); setSelectedAvailablePaperId(null); }} key={paper.id}><FileText size={14} /><span>{paper.title}</span></button>)}
                  {!papersInCollection.length ? <p>No matching papers.</p> : null}
                </div>
                <TransferPagination page={currentCollectionPage} total={papersInCollection.length} pageSize={transferPageSize} onPageChange={setCollectionPaperPage} label="collection papers" />
              </div>
              <div className="transfer-actions" aria-label="Move papers">
                <button type="button" onClick={addSelectedPaperToCollection} disabled={!selectedAvailablePaperId} aria-label="Add selected paper to collection" title="Add to collection"><ChevronLeft size={17} /></button>
                <button type="button" onClick={removeSelectedPaperFromCollection} disabled={!selectedCollectionPaperId} aria-label="Remove selected paper from collection" title="Remove from collection"><ChevronRight size={17} /></button>
              </div>
              <div className="transfer-column">
                <header><strong>All remaining papers</strong><small>{papers.length - collectionPaperIds.length}</small></header>
                <PageSearch value={availablePaperQuery} onChange={(value) => { setAvailablePaperQuery(value); setAvailablePaperPage(1); }} placeholder="Search library…" />
                <div className="transfer-paper-list" role="listbox" aria-label="All remaining papers">
                  {pagedAvailablePapers.map((paper) => <button type="button" role="option" aria-selected={selectedAvailablePaperId === paper.id} className={`${selectedAvailablePaperId === paper.id ? "is-selected" : ""} ${initialCollectionPaperIds.includes(paper.id) ? "is-changed" : ""}`} onClick={() => { setSelectedAvailablePaperId(paper.id); setSelectedCollectionPaperId(null); }} key={paper.id}><FileText size={14} /><span>{paper.title}</span></button>)}
                  {!papersOutsideCollection.length ? <p>No matching papers.</p> : null}
                </div>
                <TransferPagination page={currentAvailablePage} total={papersOutsideCollection.length} pageSize={transferPageSize} onPageChange={setAvailablePaperPage} label="available papers" />
              </div>
            </div>
            <div className="transfer-paper-details">
              {selectedTransferPaper ? <span><b>{selectedTransferPaper.title}</b><small>{fullAuthorLine(selectedTransferPaper) || "Authors unavailable"} · {venueLine(selectedTransferPaper) || "Venue unavailable"} · {selectedTransferPaper.year ?? "Year unavailable"}</small></span> : <small>Select a paper to inspect it before moving.</small>}
            </div>
          </section>
        </>}
        <div className="form-actions field-span-2"><button type="button" className="secondary-action modal-action-icon" onClick={onClose} aria-label="Cancel" title="Cancel"><X size={17} /></button><button className="primary-action modal-action-icon" aria-label={editing ? `Save ${entity}` : `Create ${entity}`} title={editing ? `Save ${entity}` : `Create ${entity}`}>{editing ? <Save size={17} /> : <Plus size={17} />}</button></div>
      </form>
    </ModalFrame>
  );
}

function TransferPagination({ page, total, pageSize, onPageChange, label }: {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  label: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);
  return (
    <div className="transfer-pagination">
      <span>{start}–{end} of {total}</span>
      <nav aria-label={`${label} pages`}>
        <button type="button" onClick={() => onPageChange(1)} disabled={page <= 1} aria-label={`First ${label} page`}><ChevronsLeft size={13} /></button>
        <button type="button" onClick={() => onPageChange(page - 1)} disabled={page <= 1} aria-label={`Previous ${label} page`}><ChevronLeft size={13} /></button>
        <span>{page} / {pageCount}</span>
        <button type="button" onClick={() => onPageChange(page + 1)} disabled={page >= pageCount} aria-label={`Next ${label} page`}><ChevronRight size={13} /></button>
        <button type="button" onClick={() => onPageChange(pageCount)} disabled={page >= pageCount} aria-label={`Last ${label} page`}><ChevronsRight size={13} /></button>
      </nav>
    </div>
  );
}

function BulkEditModal({ entity, ids, onClose, mutateLibrary, onComplete }: {
  entity: "author" | "venue";
  ids: string[];
  onClose: () => void;
  mutateLibrary: (body: MutationBody, successMessage: string) => Promise<boolean>;
  onComplete: () => void;
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const data: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      if (String(value).trim()) {
        data[key] = value;
      }
    }
    const succeeded = await mutateLibrary({ entity, action: "bulk-update", ids, data }, `${ids.length} ${entity} records updated.`);
    if (succeeded) {
      onComplete();
      onClose();
    }
  }
  return (
    <ModalFrame title={`Bulk edit ${ids.length} ${entity}s`} subtitle="Only filled fields will be applied to every selected record." onClose={onClose}>
      <form className="modal-body entity-form" onSubmit={submit}>
        {entity === "author" ? <>
          <label className="field-span-2"><span>Notes</span><textarea name="notes" rows={4} placeholder="Add shared notes" /></label>
        </> : <>
          <label><span>Type</span><select name="type" defaultValue=""><option value="">Leave unchanged</option><option value="conference">Conference</option><option value="journal">Journal</option><option value="workshop">Workshop</option><option value="preprint">Preprint archive</option><option value="other">Other</option></select></label>
          <label><span>Publisher</span><input name="publisher" placeholder="Apply a publisher" /></label>
          <label className="field-span-2"><span>Notes</span><textarea name="notes" rows={4} placeholder="Add shared notes" /></label>
        </>}
        <div className="bulk-warning field-span-2"><Database size={16} /><span><strong>Linked data stays intact.</strong> These changes will be visible immediately on every related paper.</span></div>
        <div className="form-actions field-span-2"><button type="button" className="secondary-action modal-action-icon" onClick={onClose} aria-label="Cancel" title="Cancel"><X size={17} /></button><button className="primary-action modal-action-icon" aria-label={`Apply changes to ${ids.length} records`} title={`Apply to ${ids.length} records`}><Save size={17} /></button></div>
      </form>
    </ModalFrame>
  );
}

function CommandPalette({ snapshot, onClose, setView, openPaper, addPaper }: {
  snapshot: LibrarySnapshot;
  onClose: () => void;
  setView: (view: ViewId) => void;
  openPaper: (paper: Paper) => void;
  addPaper: () => void;
}) {
  const [query, setQuery] = useState("");
  const matches = snapshot.papers.filter((paper) => matchesSearch([paper.title, authorLine(paper), venueLine(paper)], query)).slice(0, 5);
  const actions = navigation.filter((item) => matchesSearch([item.label], query));
  return (
    <div className="command-layer">
      <button className="modal-scrim" onClick={onClose} aria-label="Close search" />
      <section className="command-card" role="dialog" aria-modal="true" aria-label="Search Paper Assistant">
        <label className="command-input"><Search size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search or jump to…" autoFocus /><kbd>ESC</kbd></label>
        <div className="command-results">
          <p>Quick actions</p>
          <button onClick={() => { addPaper(); onClose(); }}><span className="command-icon"><Plus size={16} /></span><span><strong>Add a new paper</strong><small>Search, URL, or manual entry</small></span><kbd>N</kbd></button>
          {actions.map((action) => {
            const Icon = action.icon;
            return <button key={action.id} onClick={() => { setView(action.id); onClose(); }}><span className="command-icon"><Icon size={16} /></span><span><strong>Go to {action.label}</strong><small>Open the {action.label.toLowerCase()} view</small></span><ArrowRight size={15} /></button>;
          })}
          {matches.length ? <p>Papers</p> : null}
          {matches.map((paper) => <button key={paper.id} onClick={() => { openPaper(paper); onClose(); }}><span className="command-icon"><FileText size={16} /></span><span><strong>{paper.title}</strong><small>{fullAuthorLine(paper)} · {paper.year}</small></span><ArrowRight size={15} /></button>)}
        </div>
        <div className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span>PA command palette</span></div>
      </section>
    </div>
  );
}
