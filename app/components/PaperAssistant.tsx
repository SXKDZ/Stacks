"use client";

import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
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
type AuthorColumnKey = "author" | "affiliation" | "papers" | "latest";
type VenueColumnKey = "venue" | "type" | "publisher" | "papers" | "latest";

const defaultPaperColumnWidths: Record<PaperColumnKey, number> = {
  title: 60,
  venue: 20,
  year: 8,
  status: 12,
};

const defaultAuthorColumnWidths: Record<AuthorColumnKey, number> = {
  author: 42,
  affiliation: 34,
  papers: 12,
  latest: 12,
};

const defaultVenueColumnWidths: Record<VenueColumnKey, number> = {
  venue: 35,
  type: 15,
  publisher: 26,
  papers: 12,
  latest: 12,
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

const viewTitles: Record<ViewId, { eyebrow: string; title: string; description: string }> = {
  home: {
    eyebrow: "Research workspace",
    title: "Your research, in motion.",
    description: "A clear view of what you are reading, collecting, and connecting.",
  },
  library: {
    eyebrow: "Paper library",
    title: "All papers",
    description: "Search, sort, and manage the evidence behind your work.",
  },
  authors: {
    eyebrow: "People index",
    title: "Authors",
    description: "One canonical profile for every researcher in your library.",
  },
  venues: {
    eyebrow: "Publication index",
    title: "Venues",
    description: "Normalize conferences, journals, workshops, and preprint archives.",
  },
  collections: {
    eyebrow: "Research map",
    title: "Collections",
    description: "Shape papers into projects, reading lists, and lines of inquiry.",
  },
  discover: {
    eyebrow: "Academic discovery",
    title: "Find what matters next.",
    description: "Search scholarly sources and bring clean metadata straight into PA.",
  },
  settings: {
    eyebrow: "Application environment",
    title: "Settings",
    description: "Configure models, integrations, and live PA sync in one place.",
  },
};

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

interface MutationBody {
  entity: "paper" | "author" | "venue" | "collection";
  action: "create" | "update" | "delete" | "bulk-update" | "bulk-delete";
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

  async function summarizePaper(paper: Paper): Promise<boolean> {
    try {
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
      const payload = (await response.json()) as { summary: string };
      return mutateLibrary(
        { entity: "paper", action: "update", id: paper.id, data: { summary: payload.summary } },
        "Summary generated and saved.",
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "Summary generation failed.", "error");
      return false;
    }
  }

  const title = viewTitles[view];
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
              <span>Research OS</span>
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
          <span className={`sync-dot ${demoMode ? "is-demo" : ""}`} />
          <span>
            <strong>{demoMode ? "Preview library" : libraryName.trim() || "My Paper Library"}</strong>
            <small>{demoMode ? "Waiting for D1" : `${snapshot.stats.papers} papers · D1-backed library`}</small>
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
          <div className="page-heading">
            <div>
              <p className="eyebrow">{title.eyebrow}</p>
              <h1>{title.title}</h1>
              <p>{title.description}</p>
            </div>
            {view !== "home" && view !== "discover" && view !== "settings" ? (
              <button
                className="primary-action"
                onClick={() => {
                  if (view === "library") {
                    setModal({ kind: "add-paper" });
                  } else if (view === "authors") {
                    setModal({ kind: "entity", entity: "author" });
                  } else if (view === "venues") {
                    setModal({ kind: "entity", entity: "venue" });
                  } else {
                    setModal({ kind: "entity", entity: "collection" });
                  }
                }}
              >
                <Plus size={17} />
                {view === "library" ? "Add paper" : `New ${view.slice(0, -1)}`}
              </button>
            ) : null}
          </div>

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
              onOpenPapers={(author) => {
                setQuery(author.displayName);
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
              onOpenPapers={(venue) => {
                setQuery(venue.acronym || venue.name);
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
              onOpen={(collection) => {
                setQuery(collection.name);
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
          onSummarize={summarizePaper}
          onDelete={() => void deleteRecords("paper", [selectedPaper.id])}
          onOpenAuthor={(authorName) => {
            setQuery(authorName);
            setView("library");
            setSelectedPaper(null);
          }}
          onOpenVenue={() => {
            setQuery(venueLine(selectedPaper));
            setView("library");
            setSelectedPaper(null);
          }}
          onOpenCollection={(collectionName) => {
            setQuery(collectionName);
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
  const recentPapers = snapshot.papers.slice(0, 4);
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
              <span>{authorLine(currentPaper)}</span>
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
            <button className="recent-row" key={paper.id} onClick={() => openPaper(paper)}>
              <span className={`type-tile type-${paper.paperType}`}><FileText size={18} /></span>
              <span className="recent-copy">
                <strong>{paper.title}</strong>
                <small>{authorLine(paper)} · {venueLine(paper)} {paper.year}</small>
              </span>
              <StatusPill status={paper.readingStatus} />
              <ArrowUpRight size={16} className="row-arrow" />
            </button>
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
  selected,
  setSelected,
  openPaper,
  deleteSelected,
  updatePaper,
}: {
  papers: Paper[];
  query: string;
  setQuery: (value: string) => void;
  selected: string[];
  setSelected: (value: string[]) => void;
  openPaper: (paper: Paper) => void;
  deleteSelected: () => void;
  updatePaper: (paper: Paper, data: Record<string, unknown>, message: string) => Promise<void>;
}) {
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState<{ key: "recent" | "title" | "venue" | "year" | "status"; direction: "asc" | "desc" }>({ key: "recent", direction: "desc" });
  const [columnWidths, setColumnWidths] = useState<Record<PaperColumnKey, number>>(defaultPaperColumnWidths);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = JSON.parse(window.localStorage.getItem("pa-paper-grid-widths-v2") ?? "null") as Partial<Record<PaperColumnKey, number>> | null;
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
      const queryMatch = matchesSearch(
        [paper.title, paper.abstract, paper.year, paper.venueName, paper.venueAcronym, ...paper.authors.map((author) => author.displayName), ...paper.collections.map((collection) => collection.name)],
        query,
      );
      return statusMatch && queryMatch;
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
  }, [papers, query, sort, status]);

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
        window.localStorage.setItem("pa-paper-grid-widths-v2", JSON.stringify(next));
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
      window.localStorage.setItem("pa-paper-grid-widths-v2", JSON.stringify(next));
      return next;
    });
  }

  function toggleAll() {
    const visibleIds = filtered.map((paper) => paper.id);
    if (visibleIds.every((id) => selected.includes(id))) {
      setSelected(selected.filter((id) => !visibleIds.includes(id)));
    } else {
      setSelected(Array.from(new Set([...selected, ...visibleIds])));
    }
  }

  return (
    <div className="data-view">
      <div className="view-toolbar library-toolbar">
        <label className="inline-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, authors, venues…" />
          {query ? <button onClick={() => setQuery("")} aria-label="Clear search"><X size={14} /></button> : null}
        </label>
        <div className="filter-tabs">
          {["all", "inbox", "reading", "complete", "favorite"].map((item) => (
            <button key={item} className={status === item ? "is-active" : ""} onClick={() => setStatus(item)}>
              {item === "all" ? "All" : item === "favorite" ? "Starred" : statusLabel(item)}
            </button>
          ))}
        </div>
        {selected.length ? (
          <div className="library-selection-actions">
            <span><CheckCircle2 size={15} /> {selected.length} selected</span>
            <button onClick={() => setSelected([])}>Clear</button>
            <button className="danger-text" onClick={deleteSelected}><Trash2 size={14} /> Delete</button>
          </div>
        ) : null}
      </div>

      {filtered.length ? (
        <div className="paper-table-wrap paper-grid-shell">
          <table className="paper-table research-grid">
            <colgroup>
              <col className="paper-column-check" />
              <col style={{ width: `${columnWidths.title}%` }} />
              <col style={{ width: `${columnWidths.venue}%` }} />
              <col style={{ width: `${columnWidths.year}%` }} />
              <col style={{ width: `${columnWidths.status}%` }} />
            </colgroup>
            <thead>
              <tr>
                <th className="check-cell" scope="col">
                  <button onClick={toggleAll} aria-label="Select all visible papers">
                    <SelectionBox checked={Boolean(filtered.length) && filtered.every((paper) => selected.includes(paper.id))} />
                  </button>
                </th>
                <SortablePaperHeader label="Paper" sortKey="title" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
                <SortablePaperHeader label="Venue" sortKey="venue" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
                <SortablePaperHeader label="Year" sortKey="year" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
                <SortablePaperHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((paper) => (
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
                          <small>{authorLine(paper)}</small>
                        </span>
                        <span className="paper-collection-line" aria-label="Collections">
                          {paper.collections.slice(0, 3).map((collection) => <i key={collection.id} className={`chip-${collection.color}`}>{collection.name}</i>)}
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
          <div className="table-footer">Showing {filtered.length} of {papers.length} papers</div>
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
  onOpenPapers: (author: Author) => void;
}) {
  const [sort, setSort] = useState<{ key: "author" | "affiliation" | "papers" | "latest"; direction: "asc" | "desc" }>({ key: "author", direction: "asc" });
  const { widths, resizeColumn, resetColumnWidth } = useResizableColumns<AuthorColumnKey>(
    "pa-author-grid-widths-v1",
    defaultAuthorColumnWidths,
    { author: 220, affiliation: 160, papers: 80, latest: 80 },
  );
  const filtered = useMemo(() => authors
    .filter((author) => matchesSearch([author.displayName, author.affiliation], query))
    .sort((left, right) => {
      let comparison = 0;
      if (sort.key === "author") comparison = left.displayName.localeCompare(right.displayName);
      if (sort.key === "affiliation") comparison = (left.affiliation ?? "").localeCompare(right.affiliation ?? "");
      if (sort.key === "papers") comparison = left.paperCount - right.paperCount;
      if (sort.key === "latest") comparison = (left.latestYear ?? 0) - (right.latestYear ?? 0);
      return sort.direction === "asc" ? comparison : -comparison;
    }), [authors, query, sort]);
  function toggleSort(key: typeof sort.key) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: key === "papers" || key === "latest" ? "desc" : "asc" });
  }
  function toggleAll() {
    const visibleIds = filtered.map((author) => author.id);
    if (visibleIds.every((id) => selected.includes(id))) {
      setSelected(selected.filter((id) => !visibleIds.includes(id)));
      return;
    }
    setSelected(Array.from(new Set([...selected, ...visibleIds])));
  }
  return (
    <div className="data-view">
      <EntityToolbar query={query} setQuery={setQuery} placeholder="Search names and affiliations…" selected={selected.length} onClear={() => setSelected([])} onBulk={onBulk} onDelete={onDelete} />
      <div className="data-grid-shell author-table-wrap">
        <table className="paper-table research-grid entity-research-grid author-grid">
          <colgroup>
            <col className="paper-column-check" />
            <col style={{ width: `${widths.author}%` }} />
            <col style={{ width: `${widths.affiliation}%` }} />
            <col style={{ width: `${widths.papers}%` }} />
            <col style={{ width: `${widths.latest}%` }} />
            <col className="entity-column-actions" />
          </colgroup>
          <thead>
            <tr>
              <th className="check-cell" scope="col">
                <button onClick={toggleAll} aria-label="Select all visible authors">
                  <SelectionBox checked={Boolean(filtered.length) && filtered.every((author) => selected.includes(author.id))} />
                </button>
              </th>
              <SortableEntityHeader label="Author" columnKey="author" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
              <SortableEntityHeader label="Affiliation" columnKey="affiliation" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
              <SortableEntityHeader label="Papers" columnKey="papers" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} centered />
              <SortableEntityHeader label="Latest" columnKey="latest" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} centered />
              <th className="actions-cell" scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((author, index) => (
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
                <td className="entity-meta-cell">{author.affiliation || "—"}</td>
                <td className="entity-number-cell">{author.paperCount}</td>
                <td className="entity-number-cell">{author.latestYear ?? "—"}</td>
                <td className="actions-cell"><button className="row-icon-button" onClick={() => onEdit(author)} aria-label={`Edit ${author.displayName}`} title="Edit author"><Pencil size={15} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="table-footer">Showing {filtered.length} of {authors.length} authors</div>
      </div>
      {!filtered.length ? <EmptyState icon={<UsersRound size={24} />} title="No authors found" detail="Try another name or affiliation." /> : null}
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
  onOpenPapers: (venue: Venue) => void;
}) {
  const [sort, setSort] = useState<{ key: "venue" | "type" | "publisher" | "papers" | "latest"; direction: "asc" | "desc" }>({ key: "venue", direction: "asc" });
  const { widths, resizeColumn, resetColumnWidth } = useResizableColumns<VenueColumnKey>(
    "pa-venue-grid-widths-v1",
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
  function toggleSort(key: typeof sort.key) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: key === "papers" || key === "latest" ? "desc" : "asc" });
  }
  function toggleAll() {
    const visibleIds = filtered.map((venue) => venue.id);
    if (visibleIds.every((id) => selected.includes(id))) {
      setSelected(selected.filter((id) => !visibleIds.includes(id)));
      return;
    }
    setSelected(Array.from(new Set([...selected, ...visibleIds])));
  }
  return (
    <div className="data-view">
      <EntityToolbar query={query} setQuery={setQuery} placeholder="Search venue names, types, and publishers…" selected={selected.length} onClear={() => setSelected([])} onBulk={onBulk} onDelete={onDelete} />
      <div className="data-grid-shell venue-table-wrap">
        <table className="paper-table research-grid entity-research-grid venue-grid">
          <colgroup>
            <col className="paper-column-check" />
            <col style={{ width: `${widths.venue}%` }} />
            <col style={{ width: `${widths.type}%` }} />
            <col style={{ width: `${widths.publisher}%` }} />
            <col style={{ width: `${widths.papers}%` }} />
            <col style={{ width: `${widths.latest}%` }} />
            <col className="entity-column-actions" />
          </colgroup>
          <thead>
            <tr>
              <th className="check-cell" scope="col">
                <button onClick={toggleAll} aria-label="Select all visible venues">
                  <SelectionBox checked={Boolean(filtered.length) && filtered.every((venue) => selected.includes(venue.id))} />
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
            {filtered.map((venue) => (
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
        <div className="table-footer">Showing {filtered.length} of {venues.length} venues</div>
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
  onOpen,
}: {
  collections: Collection[];
  papers: Paper[];
  query: string;
  setQuery: (value: string) => void;
  onEdit: (collection: Collection) => void;
  onDelete: (collection: Collection) => void;
  onOpen: (collection: Collection) => void;
}) {
  const filtered = collections.filter((collection) => matchesSearch([collection.name, collection.description], query));
  return (
    <div className="data-view">
      <div className="view-toolbar compact-toolbar"><label className="inline-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search collections…" /></label></div>
      <div className="collection-grid">
        {filtered.map((collection) => {
          const related = papers.filter((paper) => paper.collections.some((paperCollection) => paperCollection.id === collection.id));
          return (
            <article className="collection-card" key={collection.id}>
              <div className="collection-card-top">
                <span className="collection-icon"><FolderOpen size={18} /><i className={`collection-swatch swatch-${collection.color}`} /></span>
                <div className="collection-actions">
                  <button type="button" className="row-icon-button" onClick={() => onEdit(collection)} aria-label={`Edit ${collection.name}`} title="Edit collection"><Pencil size={15} /></button>
                  <button type="button" className="row-icon-button is-danger" onClick={() => onDelete(collection)} aria-label={`Delete ${collection.name}`} title="Delete collection"><Trash2 size={15} /></button>
                </div>
              </div>
              <button className="collection-main" onClick={() => onOpen(collection)}>
                <h3>{collection.name}</h3>
                {collection.description ? <p>{collection.description}</p> : null}
                <span>{collection.paperCount} {collection.paperCount === 1 ? "paper" : "papers"}</span>
              </button>
              <div className="collection-papers">
                {related.slice(0, 2).map((paper) => <span key={paper.id}><FileText size={14} />{paper.title}</span>)}
                {!related.length ? <span className="row-muted">No papers yet</span> : null}
              </div>
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

function EntityToolbar({ query, setQuery, placeholder, selected, onClear, onBulk, onDelete }: {
  query: string;
  setQuery: (value: string) => void;
  placeholder: string;
  selected: number;
  onClear: () => void;
  onBulk: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="view-toolbar entity-toolbar">
      <label className="inline-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} /></label>
      {selected ? (
        <div className="selection-actions">
          <span>{selected} selected</span>
          <button onClick={onBulk}><Pencil size={14} /> Bulk edit</button>
          <button className="danger-text" onClick={onDelete}><Trash2 size={14} /> Delete</button>
          <button className="icon-button" onClick={onClear} aria-label="Clear selection"><X size={15} /></button>
        </div>
      ) : null}
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
        <div className="discover-search-box">
          <Search size={21} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a topic, title, DOI, or researcher" autoFocus />
          <button type="submit" disabled={loading || !query.trim()}>{loading ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />} Search</button>
        </div>
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
        <p className="provider-detail">{discoveryProviders.find((item) => item.id === provider)?.detail}</p>
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

function PaperDetail({ paper, onClose, onUpdate, onChat, onRead, onEdit, onSummarize, onDelete, onOpenAuthor, onOpenVenue, onOpenCollection }: {
  paper: Paper;
  onClose: () => void;
  onUpdate: (paper: Paper, data: Record<string, unknown>, message: string) => Promise<void>;
  onChat: () => void;
  onRead: () => void;
  onEdit: () => void;
  onSummarize: (paper: Paper) => Promise<boolean>;
  onDelete: () => void;
  onOpenAuthor: (authorName: string) => void;
  onOpenVenue: () => void;
  onOpenCollection: (collectionName: string) => void;
}) {
  const [summarizing, setSummarizing] = useState(false);

  async function generateSummary() {
    setSummarizing(true);
    await onSummarize(paper);
    setSummarizing(false);
  }

  const hasViewer = Boolean(paper.pdfUrl || paper.htmlUrl);
  return (
    <div className="drawer-layer">
      <button className="drawer-scrim" onClick={onClose} aria-label="Close paper details" />
      <aside className="detail-drawer" aria-label="Paper details">
        <div className="drawer-header">
          <span className="drawer-label"><FileText size={15} /> Paper details</span>
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
              <div className="collection-chips large-chips">{paper.collections.length ? paper.collections.map((collection) => <button type="button" key={collection.id} className={`chip-${collection.color}`} onClick={() => onOpenCollection(collection.name)}>{collection.name}</button>) : <span className="row-muted">No collections yet</span>}</div>
            </div>
          </div>
          <div className="drawer-cta-row">
            {hasViewer ? <button className="primary-action" onClick={onRead}><BookOpen size={16} /> Read inside PA</button> : null}
            <button className="secondary-action" onClick={onChat}><Sparkles size={16} /> Ask PA</button>
            <button className="secondary-action" onClick={onEdit}><Pencil size={15} /> Edit</button>
          </div>
          {paper.url ? <a className="source-link" href={paper.url} target="_blank" rel="noreferrer">Open source page <ExternalLink size={12} /></a> : null}
          <div className="detail-section summary-section">
            <div className="detail-section-heading">
              <p className="eyebrow">PA summary</p>
              <button onClick={() => void generateSummary()} disabled={summarizing}>
                {summarizing ? <LoaderCircle size={13} className="spin" /> : <WandSparkles size={13} />}
                {paper.summary ? "Regenerate" : "Generate summary"}
              </button>
            </div>
            {paper.summary ? <MarkdownContent content={paper.summary} className="summary-copy" /> : <p className="summary-empty">No summary yet. PA can ground one in the paper’s source and metadata.</p>}
          </div>
          <div className="detail-section">
            <p className="eyebrow">Abstract</p>
            <MarkdownContent content={paper.abstract || "No abstract is recorded for this paper."} />
          </div>
          {paper.volume || paper.issue || paper.pages || paper.category ? (
            <div className="detail-section">
              <p className="eyebrow">Publication details</p>
              <div className="publication-grid">
                {paper.volume ? <span><small>Volume</small><strong>{paper.volume}</strong></span> : null}
                {paper.issue ? <span><small>Issue</small><strong>{paper.issue}</strong></span> : null}
                {paper.pages ? <span><small>Pages</small><strong>{paper.pages}</strong></span> : null}
                {paper.category ? <span><small>Category</small><strong>{paper.category}</strong></span> : null}
              </div>
            </div>
          ) : null}
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
          <div className="detail-section">
            <p className="eyebrow">Identifiers</p>
            <div className="identifier-list">
              {paper.doi ? <span><b>DOI</b>{paper.doi}</span> : null}
              {paper.preprintId || paper.arxivId ? <span><b>Preprint</b>{paper.preprintId || paper.arxivId}</span> : null}
              {paper.semanticScholarId ? <span><b>S2</b>{paper.semanticScholarId}</span> : null}
              {paper.localPath ? <span><b>File</b>{paper.localPath}</span> : null}
              {paper.htmlSnapshotPath ? <span><b>HTML</b>{paper.htmlSnapshotPath}</span> : null}
            </div>
          </div>
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
          <p className="detail-authors">{authorLine(paper)}</p>
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
      const payload = (await response.json()) as { content: string };
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
                  return <button type="button" className={selected ? "is-selected" : ""} onClick={() => toggleDiscussionPaper(item.id)} disabled={onlySelected} key={item.id}><span className="selection-box">{selected ? <Check size={11} /> : null}</span><span><strong>{item.title}</strong><small>{authorLine(item)} · {item.year ?? "n.d."}</small></span></button>;
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

  async function loadLocalFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setUploading(true);
    try {
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
      const payload = await response.json() as { storedPath: string };
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
  const [tab, setTab] = useState<"search" | "identifier" | "url" | "manual">("search");
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<DiscoveryProvider>("semantic-scholar");
  const [identifierSource, setIdentifierSource] = useState<IdentifierSource>("arxiv");
  const [identifier, setIdentifier] = useState("");
  const [results, setResults] = useState<DiscoveryResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const [manualPaperType, setManualPaperType] = useState<EditablePaperType>("conference");

  async function searchPapers(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) {
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/discover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, provider }) });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = (await response.json()) as { results: DiscoveryResult[] };
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
      const response = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const result = (await response.json()) as Record<string, unknown>;
      const succeeded = await mutateLibrary({ entity: "paper", action: "create", data: { ...result, authors: [] } }, "Page imported with Jina Reader.");
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
      const response = await fetch("/api/import-identifier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: identifierSource, identifier }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await response.json() as { paper: DiscoveryResult };
      const succeeded = await mutateLibrary(
        { entity: "paper", action: "create", data: { ...payload.paper } },
        `${identifierSources.find((source) => source.id === identifierSource)?.label ?? "Source"} paper imported.`,
      );
      if (succeeded) {
        onClose();
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "Identifier import failed.", "error");
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
    <ModalFrame title="Add to Paper Assistant" subtitle="Search academic sources, import a URL, or enter metadata yourself." onClose={onClose} className="add-modal">
      <div className="modal-tabs">
        <button className={tab === "search" ? "is-active" : ""} onClick={() => setTab("search")}><Search size={15} /> Academic search</button>
        <button className={tab === "identifier" ? "is-active" : ""} onClick={() => setTab("identifier")}><Database size={15} /> Identifier</button>
        <button className={tab === "url" ? "is-active" : ""} onClick={() => setTab("url")}><Link2 size={15} /> URL or PDF</button>
        <button className={tab === "manual" ? "is-active" : ""} onClick={() => setTab("manual")}><Pencil size={15} /> Manual</button>
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
              <button type="button" className={identifierSource === source.id ? "is-active" : ""} onClick={() => { setIdentifierSource(source.id); setIdentifier(""); }} key={source.id}>
                <Database size={16} />
                <span><strong>{source.label}</strong><small>{source.hint}</small></span>
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
          <p className="identifier-footnote">PA supports web and identifier imports here; BibTeX, RIS, and local PDF imports remain available through the companion CLI.</p>
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
          <div className="form-actions field-span-2"><button type="button" className="secondary-action" onClick={onClose}>Cancel</button><button className="primary-action"><Plus size={16} /> Add paper</button></div>
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
          summary: form.get("summary"),
          notes: form.get("notes"),
          readingStatus: form.get("readingStatus"),
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
        <label><span>Reading status</span><select name="readingStatus" defaultValue={paper.readingStatus}><option value="inbox">To read</option><option value="reading">Reading</option><option value="complete">Read</option></select></label>
        <label><span>Paper type</span><select name="paperType" value={paperType} onChange={(event) => setPaperType(event.target.value as EditablePaperType)}>{paperTypeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
        <label className="field-span-2"><span>Authors</span><input name="authors" defaultValue={paper.authors.map((author) => author.displayName).join(", ")} /><small>Comma-separated. Renaming a canonical author from the Authors view updates every linked paper.</small></label>
        <label><span>Year</span><input name="year" type="number" min="1500" max="2200" defaultValue={paper.year ?? ""} /></label>
        <span />
        <PaperMetadataFields paperType={paperType} paper={paper} notify={notify} />
        <label className="field-span-2"><span>Abstract</span><textarea name="abstract" rows={5} defaultValue={paper.abstract} /></label>
        <label className="field-span-2 summary-field"><span>PA summary</span><textarea name="summary" rows={5} defaultValue={paper.summary} /></label>
        <label className="field-span-2"><span>Research notes</span><textarea name="notes" rows={4} defaultValue={paper.notes} /></label>
        <div className="form-actions field-span-2"><button type="button" className="secondary-action" onClick={onClose}>Cancel</button><button className="primary-action"><Save size={15} /> Save paper</button></div>
      </form>
    </ModalFrame>
  );
}

function EntityModal({ entity, record, onClose, mutateLibrary }: {
  entity: "author" | "venue" | "collection";
  record?: Author | Venue | Collection;
  onClose: () => void;
  mutateLibrary: (body: MutationBody, successMessage: string) => Promise<boolean>;
}) {
  const editing = Boolean(record);
  const title = `${editing ? "Edit" : "New"} ${entity}`;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
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
  return (
    <ModalFrame title={title} subtitle={entity === "author" ? "Changes propagate to every linked paper." : entity === "venue" ? "Keep publication metadata consistent across your library." : "Define a focused space for related work."} onClose={onClose}>
      <form className="modal-body entity-form" onSubmit={submit}>
        {entity === "author" ? <>
          <label className="field-span-2"><span>Display name *</span><input name="displayName" defaultValue={author?.displayName} required autoFocus /></label>
          <label><span>Given name</span><input name="givenName" defaultValue={author?.givenName ?? ""} /></label>
          <label><span>Family name</span><input name="familyName" defaultValue={author?.familyName ?? ""} /></label>
          <label className="field-span-2"><span>Affiliation</span><input name="affiliation" defaultValue={author?.affiliation ?? ""} placeholder="University or organization" /></label>
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
          <label className="field-span-2"><span>Description</span><textarea name="description" rows={4} defaultValue={collection?.description ?? ""} /></label>
          <label className="field-span-2"><span>Color</span><select name="color" defaultValue={collection?.color ?? "violet"}><option value="violet">Violet</option><option value="cyan">Cyan</option><option value="amber">Amber</option><option value="green">Green</option><option value="rose">Rose</option></select></label>
        </>}
        <div className="form-actions field-span-2"><button type="button" className="secondary-action" onClick={onClose}>Cancel</button><button className="primary-action">{editing ? <Pencil size={16} /> : <Plus size={16} />}{editing ? "Save changes" : `Create ${entity}`}</button></div>
      </form>
    </ModalFrame>
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
          <label className="field-span-2"><span>Affiliation</span><input name="affiliation" autoFocus placeholder="Apply a shared affiliation" /></label>
          <label className="field-span-2"><span>Notes</span><textarea name="notes" rows={4} placeholder="Add shared notes" /></label>
        </> : <>
          <label><span>Type</span><select name="type" defaultValue=""><option value="">Leave unchanged</option><option value="conference">Conference</option><option value="journal">Journal</option><option value="workshop">Workshop</option><option value="preprint">Preprint archive</option><option value="other">Other</option></select></label>
          <label><span>Publisher</span><input name="publisher" placeholder="Apply a publisher" /></label>
          <label className="field-span-2"><span>Notes</span><textarea name="notes" rows={4} placeholder="Add shared notes" /></label>
        </>}
        <div className="bulk-warning field-span-2"><Database size={16} /><span><strong>Linked data stays intact.</strong> These changes will be visible immediately on every related paper.</span></div>
        <div className="form-actions field-span-2"><button type="button" className="secondary-action" onClick={onClose}>Cancel</button><button className="primary-action"><Pencil size={16} /> Apply to {ids.length}</button></div>
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
          {matches.map((paper) => <button key={paper.id} onClick={() => { openPaper(paper); onClose(); }}><span className="command-icon"><FileText size={16} /></span><span><strong>{paper.title}</strong><small>{authorLine(paper)} · {paper.year}</small></span><ArrowRight size={15} /></button>)}
        </div>
        <div className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span>PA command palette</span></div>
      </section>
    </div>
  );
}
