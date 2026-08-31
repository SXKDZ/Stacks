"use client";

import {
  AlignLeft,
  ArrowDownUp,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bot,
  Building2,
  Check,
  CheckCircle2,
  Clipboard,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  Clock3,
  Command,
  Compass,
  Database,
  Download,
  ExternalLink,
  FileText,
  FileSearch,
  FolderOpen,
  GripVertical,
  Home,
  Inbox,
  Library,
  Link2,
  ListFilter,
  LoaderCircle,
  Menu,
  NotebookPen,
  Pencil,
  Plus,
  Save,
  Search,
  Settings2,
  Sparkles,
  Star,
  Trash2,
  Upload,
  UsersRound,
  WandSparkles,
  X,
} from "lucide-react";
import type { ChangeEvent, Dispatch, DragEvent as ReactDragEvent, FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, SetStateAction } from "react";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readError } from "@/app/lib/http";
import { demoSnapshot } from "@/app/lib/demo-data";
import { SettingsView } from "@/app/components/SettingsView";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { MarkdownCodeEditor } from "@/app/components/ui/MarkdownCodeEditor";
import { AdaptiveAuthors } from "@/app/components/ui/AdaptiveAuthors";
import { BackgroundTaskDock, BackgroundTaskProvider, useBackgroundTasks, type TaskLogger } from "@/app/components/BackgroundTasks";
import { Brand } from "@/app/components/ui/Brand";
import { ThemeToggle } from "@/app/components/ui/ThemeToggle";
import { ActionButton, ActionLink, Chip, CollectionChip, cx, PaginationButton, Scrim, Select, SelectCard, StatusPill, TabButton, TextButton } from "@/app/components/ui/controls";
import { cycleTableSort, SortableTableHeader, useResizableColumns, type TableSort } from "@/app/components/ui/ResizableTable";
import { useTheme } from "@/app/lib/use-theme";
import {
  downloadReferences,
  exportReferences,
  referenceExportFormats,
  type ReferenceExportFormat,
} from "@/app/lib/reference-export";
import type {
  Author,
  Collection,
  DiscoveryResult,
  DiscoveryProvider,
  IdentifierSource,
  LibrarySnapshot,
  Paper,
  Venue,
  ViewId,
} from "@/app/lib/types";
import { editablePaperType, metadataVisibility, paperTypeOptions, type EditablePaperType } from "@/app/lib/paper-fields";
import {
  comparableMetadataValue,
  isExtractedMetadataFieldApplicable,
  type ExtractedMetadataField,
} from "@/app/lib/metadata-review";
import { matchesSearch, paperMetaLine, paperSearchValues } from "@/app/lib/paper-meta";
import { gapForPointer, moveItem, moveItemToGap } from "@/app/lib/reorder";
import { withSummarySlot } from "@/app/lib/summary-concurrency";
import { COLLECTION_COLORS, DEFAULT_COLLECTION_COLOR } from "@/app/lib/types";

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

type PaperColumnKey = "title" | "venue" | "year" | "status";
type AuthorColumnKey = "author" | "papers" | "latest";
type VenueColumnKey = "venue" | "type" | "publisher" | "papers" | "latest";

interface ExtractedPdfMetadata {
  title: string;
  authors: string[];
  abstract: string;
  year: number | null;
  venueName: string;
  venueAcronym: string;
  paperType: EditablePaperType;
  doi: string | null;
  url: string | null;
  category: string | null;
  preprintId: string | null;
}

interface PdfExtractionResponse {
  metadata: ExtractedPdfMetadata;
  analyzedPages: number;
  totalPages: number;
  usedFallback: boolean;
  warning?: string;
}

interface ExtractedMetadataChange {
  field: ExtractedMetadataField;
  label: string;
  current: string;
  extracted: string;
}

interface PendingMetadataReview {
  extraction: PdfExtractionResponse;
  changes: ExtractedMetadataChange[];
}

const extractedMetadataFields: Array<{ field: ExtractedMetadataField; label: string }> = [
  { field: "title", label: "Title" },
  { field: "authors", label: "Authors" },
  { field: "year", label: "Year" },
  { field: "paperType", label: "Paper type" },
  { field: "venueName", label: "Venue" },
  { field: "venueAcronym", label: "Venue acronym" },
  { field: "preprintId", label: "Preprint ID" },
  { field: "doi", label: "DOI" },
  { field: "url", label: "Source URL" },
  { field: "abstract", label: "Abstract" },
];

function extractedMetadataValue(metadata: ExtractedPdfMetadata, field: ExtractedMetadataField): string {
  if (field === "authors") return metadata.authors.join(", ");
  const value = metadata[field];
  return value === null || value === undefined ? "" : String(value);
}

// Default column widths as proportional shares of each table's resizable area
// (only their ratio matters). Users drag from here and their choice persists.
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

// The venue name is the column people scan, so it gets the widest default; the
// publisher is usually a short imprint and no longer takes more room than it.
const defaultVenueColumnWidths: Record<VenueColumnKey, number> = {
  venue: 38,
  type: 14,
  publisher: 20,
  papers: 10,
  latest: 10,
};

function providerLabel(provider: DiscoveryProvider): string {
  return discoveryProviders.find((item) => item.id === provider)?.label ?? provider;
}

/** The transient status message. Its own component so the icon lookup has a home. */
function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  const Icon = TOAST_ICONS[toast.tone] ?? Sparkles;
  const isAssertive = toast.tone === "error" || toast.tone === "warning";
  if (typeof document === "undefined") return null;

  return createPortal((
    <div className={`toast toast-${toast.tone}`} key={toast.id}>
      <span className="toast-message" role={isAssertive ? "alert" : "status"}>
        <Icon size={17} aria-hidden="true" />
        <span>{toast.message}</span>
      </span>
      <button type="button" className="toast-dismiss" onClick={onDismiss} aria-label="Dismiss notification">
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  ), document.body);
}

/** Toast icon per tone. A table rather than a ternary ladder in the markup. */
const TOAST_ICONS: Record<string, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: CircleAlert,
  warning: CircleAlert,
};

/** What the entity pickers call the things they search. */
const ENTITY_PLURALS: Record<string, string> = {
  author: "authors",
  venue: "venues",
  collection: "collections",
};

/** The "venue" field means something different per paper type. */
const VENUE_LABELS: Record<string, string> = {
  preprint: "Website / archive",
  website: "Website / publisher",
};

/** What editing each entity actually affects. */
const ENTITY_SUBTITLES: Record<string, string> = {
  author: "Changes apply to every paper by this author.",
  venue: "Keep this venue's details consistent everywhere.",
  collection: "Move papers between this collection and the rest of your library.",
};

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
  | { kind: "export"; papers: Paper[] }
  | { kind: "entity"; entity: "author" | "venue" | "collection"; record?: Author | Venue | Collection }
  | { kind: "bulk"; entity: "author" | "venue"; ids: string[] }
  | null;

interface ToastState {
  id: number;
  message: string;
  tone: "success" | "error" | "warning" | "info";
}

type LibraryFilterKind = "author" | "venue" | "collection" | "year";
type LibraryFilterJoin = "AND" | "OR";
type LibraryFilterOption = { id: string; label: string };

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

// A venue monogram: the leading letters of the acronym. Four uppercase glyphs
// are what makes the chip recognizable (COLM, AAAI), so the chip sets its own
// type size to fit them whole rather than clipping the widest labels.
interface SummaryGrounding {
  source: "pdf" | "webpage" | "none";
  pagesRead?: number;
  pagesSkipped?: number;
}

/**
 * One line for the activity log: what a generated summary was actually written
 * from. A review drawn from the abstract alone reads exactly like one drawn from
 * the paper, and that difference is what a reader needs before trusting it.
 */
function groundingNote(grounding?: SummaryGrounding): string {
  if (grounding?.source === "pdf") {
    const pages = grounding.pagesRead ? `${grounding.pagesRead} page${grounding.pagesRead === 1 ? "" : "s"}` : "the stored PDF";
    return grounding.pagesSkipped
      ? `Read ${pages} of the stored PDF; ${grounding.pagesSkipped} could not be parsed.`
      : `Read ${pages} of the stored PDF.`;
  }
  if (grounding?.source === "webpage") return "Read a snapshot of the paper's page.";
  return "No paper text could be read: writing from the record's metadata only.";
}

/** The toast for a saved summary, which names a metadata-only review as such. */
function summarySavedMessage(grounding?: SummaryGrounding): string {
  return grounding?.source === "pdf" || grounding?.source === "webpage"
    ? "Summary generated and saved."
    : "Summary saved. It was written from the record's metadata: the paper's text could not be read.";
}

function venueMonogram(venue: { acronym: string | null; name: string }): string {
  return (venue.acronym || venue.name).slice(0, 4);
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

/** How many lines of the abstract to show before "Show more". */
const ABSTRACT_PREVIEW_LINES = 5;

/**
 * The card's abstract, cut to a few lines with the toggle on the last one.
 *
 * The cut is measured, not a character count: how much text fits depends on the
 * column width, so a fixed count either wastes a line on a wide card or overflows a
 * narrow one and pushes "Show more" onto a line of its own. This renders the text
 * off-screen at the real column width and binary-searches the longest prefix whose
 * height, with the toggle appended, still fits the line budget.
 *
 * A CSS clamp can't do this: it clips a block, so the toggle could only ever sit
 * outside the text rather than following the ellipsis inline.
 */
function ExpandableAbstract({ abstract }: { abstract: string }) {
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState<number | null>(null);
  const ref = useRef<HTMLParagraphElement | null>(null);
  const text = abstract.trim();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setCut(previewCut(node, text, ABSTRACT_PREVIEW_LINES));
    measure();
    // Re-fit when the column resizes: the same text needs a different cut.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);

  if (!text) {
    return null;
  }
  // Until measured, render the full text: it is the honest content, and the cut
  // lands on the first layout pass.
  const truncated = cut !== null && cut < text.length;
  return (
    <p className="continue-abstract" ref={ref}>
      {expanded || !truncated ? text : `${text.slice(0, cut).trimEnd()}…`}
      {truncated ? (
        <>
          {" "}
          <button type="button" className="continue-abstract-toggle" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
            {expanded ? "Collapse abstract" : "Expand abstract"}
          </button>
        </>
      ) : null}
    </p>
  );
}

/**
 * The longest prefix of `text` that fits `lines` lines of `sample`'s column,
 * leaving room for the toggle after it. Returns text.length when it all fits.
 *
 * Measured in a clone positioned off-screen at the element's own width, so the
 * visible paragraph never flickers through intermediate states.
 */
function previewCut(sample: HTMLElement, text: string, lines: number): number {
  const styles = window.getComputedStyle(sample);
  const lineHeight = Number.parseFloat(styles.lineHeight);
  if (!Number.isFinite(lineHeight) || sample.clientWidth === 0) {
    return text.length;
  }
  const budget = lineHeight * lines + 1;
  const probe = document.createElement("p");
  probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;width:${sample.clientWidth}px;font:${styles.font};line-height:${styles.lineHeight};letter-spacing:${styles.letterSpacing};white-space:normal;margin:0`;
  document.body.append(probe);
  try {
    // " … Show less" is the longest trailing run, so budgeting for it keeps the
    // toggle on the last line in both states.
    const suffix = "… Show less";
    probe.textContent = text;
    if (probe.offsetHeight <= budget) {
      return text.length;
    }
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      probe.textContent = text.slice(0, middle) + suffix;
      if (probe.offsetHeight <= budget) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    // Back up to a word boundary so the preview never ends mid-word.
    const slice = text.slice(0, low);
    const lastSpace = slice.lastIndexOf(" ");
    const wordCut = lastSpace > low * 0.6 ? lastSpace : low;
    return wordCut;
  } finally {
    probe.remove();
  }
}

/**
 * Keep a click from reaching the row only when it actually hit a control.
 *
 * The author and collection lines are full-width flex containers, so a bare
 * `stopPropagation` on them swallowed clicks anywhere to the right of the last
 * name, leaving a dead strip where clicking a paper row did nothing.
 */
function stopIfInteractive(event: ReactMouseEvent<HTMLElement>): void {
  if ((event.target as HTMLElement).closest("button, a")) {
    event.stopPropagation();
  }
}

function venueLine(paper: Paper): string {
  return paper.venueAcronym || paper.venueName || "Unassigned venue";
}

function doiHref(value: string): string {
  const identifier = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
  return `https://doi.org/${identifier}`;
}

/**
 * The venue's full name, for a cell that only has room for the acronym.
 *
 * Undefined when there is nothing to add: no full name recorded, or a name the
 * cell is already showing because no acronym exists.
 */
function venueFullNameHint(paper: Paper): string | undefined {
  const name = paper.venueName?.trim();
  if (!name || !paper.venueAcronym?.trim() || name === paper.venueAcronym.trim()) {
    return undefined;
  }
  return name;
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    inbox: "To read",
    reading: "Reading",
    complete: "Read",
  };
  return labels[value] ?? value;
}

/** The icon paired with each reading status (matches StatusPill's mapping). */
function StatusIcon({ status, size = 14 }: { status: string; size?: number }): ReactNode {
  if (status === "complete") return <CheckCircle2 size={size} />;
  if (status === "reading") return <Clock3 size={size} />;
  return <Inbox size={size} />;
}

function matchesLibraryClause(paper: Paper, clause: LibraryFilterClause): boolean {
  // An unset clause (no value chosen yet, or switched to a kind with no options)
  // must not filter everything out — treat it as always-true so it's a no-op,
  // even when negated.
  if (!clause.valueId) {
    return true;
  }
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


interface SourceAcquisitionResult {
  kind: "pdf" | "html";
  storedPath: string;
  fileUrl: string;
  sourceUrl: string;
}

interface SourceAssetStatus {
  localPath: string | null;
  htmlSnapshotPath: string | null;
  pdfExists: boolean;
  htmlExists: boolean;
}

function paperValue(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}

function validatePaperWrite(data: Record<string, unknown>): string | null {
  const currentYear = new Date().getFullYear();
  const title = paperValue(data, "title");
  if (!title) {
    return "A paper title is required.";
  }
  if (title.length > 1000) {
    return "The paper title must be 1,000 characters or fewer.";
  }
  const yearValue = paperValue(data, "year");
  if (yearValue) {
    const year = Number(yearValue);
    if (!Number.isInteger(year) || year < 1500 || year > currentYear + 1) {
      return `Year must be a whole number between 1500 and ${currentYear + 1}.`;
    }
  }
  for (const [field, label] of [["url", "Source URL"], ["pdfUrl", "PDF URL"]] as const) {
    const value = paperValue(data, field);
    if (value) {
      try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return `${label} must use http:// or https://.`;
        }
      } catch {
        return `${label} must be a complete http:// or https:// URL.`;
      }
    }
  }
  const doi = paperValue(data, "doi");
  if (doi && !/^10\.\d{4,9}\/\S+$/i.test(doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ""))) {
    return "DOI must look like 10.1234/example.";
  }
  for (const [field, extension, label] of [
    ["localPath", /\.pdf$/i, "Local PDF path"],
    ["htmlSnapshotPath", /\.html?$/i, "Local HTML path"],
  ] as const) {
    const value = paperValue(data, field);
    if (value && (value.includes("/") || value.includes("\\") || value === "." || value === ".." || !extension.test(value))) {
      return `${label} must be a portable filename${field === "localPath" ? " ending in .pdf" : " ending in .html or .htm"}, without folders.`;
    }
  }
  const boundedFields = ["volume", "issue", "pages", "category", "preprintId", "venueName", "venueAcronym"];
  for (const field of boundedFields) {
    const value = paperValue(data, field);
    if (value.length > 300 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
      return `${field.replace(/([A-Z])/g, " $1")} contains invalid or excessive text.`;
    }
  }
  const authors = Array.isArray(data.authors) ? data.authors : [];
  if (authors.some((author) => typeof author !== "string" || !author.trim() || author.trim().length > 300)) {
    return "Each author must have a non-empty name of 300 characters or fewer.";
  }
  const collectionNames = Array.isArray(data.collectionNames) ? data.collectionNames : [];
  if (collectionNames.some((name) => typeof name !== "string" || !name.trim() || name.trim().length > 200)) {
    return "Each collection must have a non-empty name of 200 characters or fewer.";
  }
  return null;
}

function acquisitionPayload(data: Record<string, unknown>, preferred: "auto" | "pdf" | "html" = "auto") {
  const pdfUrl = paperValue(data, "pdfUrl");
  return {
    operation: "acquire" as const,
    preferred,
    title: paperValue(data, "title"),
    sourceUrl: paperValue(data, "url"),
    pdfUrl: /^https?:\/\//i.test(pdfUrl) ? pdfUrl : "",
    preprintId: paperValue(data, "preprintId"),
    localPath: paperValue(data, "localPath"),
    htmlSnapshotPath: paperValue(data, "htmlSnapshotPath"),
  };
}

function hasAcquirableSource(data: Record<string, unknown>): boolean {
  const payload = acquisitionPayload(data);
  return Boolean(payload.sourceUrl || payload.pdfUrl || payload.preprintId);
}

async function acquirePaperSource(
  data: Record<string, unknown>,
  preferred: "auto" | "pdf" | "html" = "auto",
): Promise<SourceAcquisitionResult> {
  const response = await fetch("/api/source-acquisition", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(acquisitionPayload(data, preferred)),
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.json() as Promise<SourceAcquisitionResult>;
}

async function checkPaperAssets(data: Record<string, unknown>): Promise<SourceAssetStatus> {
  const response = await fetch("/api/source-acquisition", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operation: "check",
      localPath: paperValue(data, "localPath"),
      htmlSnapshotPath: paperValue(data, "htmlSnapshotPath"),
    }),
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.json() as Promise<SourceAssetStatus>;
}

function withAcquiredSource(data: Record<string, unknown>, result: SourceAcquisitionResult): Record<string, unknown> {
  return result.kind === "pdf"
    ? { ...data, localPath: result.storedPath }
    : { ...data, htmlSnapshotPath: result.storedPath };
}

async function extractPdfMetadata(file: Blob, filename: string): Promise<PdfExtractionResponse> {
  const response = await fetch("/api/extract-pdf", {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      "X-Stacks-File-Name": encodeURIComponent(filename),
    },
    body: file,
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.json() as Promise<PdfExtractionResponse>;
}

function SelectionBox({ checked }: { checked: boolean }) {
  return (
    <span className={`selection-box ${checked ? "is-checked" : ""}`} aria-hidden="true">
      {checked ? <Check size={13} strokeWidth={3} /> : null}
    </span>
  );
}

function EmptyState({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      <p>{detail}</p>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}

export default function Stacks() {
  return <BackgroundTaskProvider><StacksWorkspace /></BackgroundTaskProvider>;
}

function StacksWorkspace() {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>(demoSnapshot);
  const [view, setView] = useState<ViewId>("home");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [demoMode, setDemoMode] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [selectedPaper, setSelectedPaper] = useState<Paper | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [selectedPapers, setSelectedPapers] = useState<string[]>([]);
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);
  const [selectedVenues, setSelectedVenues] = useState<string[]>([]);
  const [toast, setToast] = useState<ToastState | null>(null);
  const { theme, setTheme } = useTheme();
  const [libraryName, setLibraryName] = useState("My Paper Library");
  const [libraryFilters, setLibraryFilters] = useState<LibraryFilterClause[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousView = useRef<ViewId>(view);

  const notify = useCallback((message: string, tone: ToastState["tone"] = "success") => {
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
    }
    const next = { id: Date.now(), message, tone };
    setToast(next);
    if (tone !== "error" && tone !== "warning") {
      toastTimer.current = setTimeout(() => {
        setToast(null);
      }, 5000);
    }
  }, []);

  // Fetches the latest library snapshot. Runs on mount and whenever the tab
  // regains focus/visibility, so the sidebar and views stay fresh without a
  // manual refresh control.
  async function loadLibrary() {
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
      setDemoMode(false);
      notify(successMessage);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save the change. Check your connection and try again.";
      notify(message, "error");
      return false;
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadLibrary();
    }, 0);
    // Refresh whenever the tab regains focus so changes made elsewhere (the
    // feed page approving a proposal, another window) show up without a manual
    // reload.
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadLibrary();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Deep link: `/?paper=<id>` opens that paper's detail once the library has
  // loaded (e.g. clicking a paper attachment on the feed page). Consumed once,
  // then stripped from the URL so a refresh doesn't reopen it. Reads the param
  // from window.location to avoid a Suspense boundary for useSearchParams.
  const paperDeepLinkHandled = useRef(false);
  useEffect(() => {
    if (paperDeepLinkHandled.current || !snapshot.papers.length) return;
    const target = new URLSearchParams(window.location.search).get("paper");
    if (!target) {
      paperDeepLinkHandled.current = true;
      return;
    }
    const paper = snapshot.papers.find((candidate) => candidate.id === target);
    if (paper) {
      paperDeepLinkHandled.current = true;
      setView("library");
      setSelectedPaper(paper);
      const url = new URL(window.location.href);
      url.searchParams.delete("paper");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  }, [snapshot.papers]);

  // The library name is a real setting (settings.json), loaded from the API so
  // it's consistent with the feed and survives a localStorage clear. The
  // localStorage read is a one-time migration fallback for pre-setting installs.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/local-settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { libraryName?: string } | null) => {
        if (cancelled) return;
        const fromSettings = data?.libraryName?.trim();
        const fromLocal = window.localStorage.getItem("stacks-library-name")?.trim();
        if (fromSettings && fromSettings !== "My Paper Library") {
          setLibraryName(fromSettings);
        } else if (fromLocal) {
          setLibraryName(fromLocal);
        } else if (fromSettings) {
          setLibraryName(fromSettings);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // What Escape should dismiss, read live: the keydown listener below is registered
  // once, so it would otherwise close against the state as it was at mount.
  const layers = useRef({ modal, commandOpen, mobileNav });
  useEffect(() => {
    layers.current = { modal, commandOpen, mobileNav };
  }, [modal, commandOpen, mobileNav]);

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
        // Dismiss only the topmost layer. Closing all three at once meant pressing
        // Escape in the edit modal opened from a paper's detail panel took the panel
        // down with it, losing the place the user was working from.
        if (layers.current.commandOpen) setCommandOpen(false);
        else if (layers.current.modal) setModal(null);
        else if (layers.current.mobileNav) closeMobileNavigation();
        else setSelectedPaper(null);
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

  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLHeadingElement>(".view-heading")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [view]);

  function openMobileNavigation() {
    setMobileNav(true);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(".mobile-close")?.focus();
    });
  }

  function closeMobileNavigation() {
    setMobileNav(false);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(".mobile-menu")?.focus();
    });
  }

  function changeView(nextView: ViewId) {
    setView((current) => {
      // The search box text is interpreted differently per view (author names
      // vs venue names vs titles), so reset it only when the view actually
      // changes. The library's structured filter expression is preserved so it
      // survives a round-trip through other views.
      if (current !== nextView) {
        setQuery("");
      }
      return nextView;
    });
    setMobileNav(false);
    setSelectedPaper(null);
  }

  function openFeedWorkspace(paper?: Paper | null) {
    const target = paper ? `/feed?paper=${encodeURIComponent(paper.id)}` : "/feed";
    window.open(target, "_blank", "noopener,noreferrer");
  }

  function openReaderWorkspace(paper: Paper) {
    window.open(`/reader?paper=${encodeURIComponent(paper.id)}`, "_blank", "noopener,noreferrer");
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
  const currentViewLabel = navigation.find((item) => item.id === view)?.label ?? "Overview";

  return (
    <div className="stacks-shell workspace-enter app-interaction-scope">
      <a className="skip-link" href="#main-content" tabIndex={mobileNav ? -1 : 0}>Skip to content</a>
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`} aria-label="Primary navigation">
        <div className="brand-row">
          <button className="brand" onClick={() => changeView("home")} aria-label="Stacks home">
            <Brand subtitle="Read deeper. Connect further." />
          </button>
          <ActionButton variant="ghost" size="icon" className="mobile-close" onClick={closeMobileNavigation} aria-label="Close navigation" icon={<X />} />
        </div>

        <ActionButton
          variant="primary"
          className="new-paper-button"
          onClick={() => setModal({ kind: "add-paper" })}
          icon={<Plus strokeWidth={2.4} />}
          kbd="N"
        >Add paper</ActionButton>

        <nav className="main-nav" aria-label="Main navigation">
          <p className="nav-label">Workspace</p>
          {navigation.map((item) => {
            const Icon = item.icon;
            // A lookup, not a ternary ladder: adding a counted view is one entry.
            const counts: Partial<Record<ViewId, number>> = {
              library: snapshot.stats.papers,
              authors: snapshot.stats.authors,
              venues: snapshot.stats.venues,
              collections: snapshot.collections.length,
            };
            const count = counts[item.id] ?? null;
            return (
              <button
                key={item.id}
                className={`nav-item ${view === item.id ? "is-active" : ""}`}
                onClick={() => changeView(item.id)}
                aria-current={view === item.id ? "page" : undefined}
              >
                <Icon size={17} strokeWidth={2} />
                <span>{item.label}</span>
                {count !== null ? <span className="nav-count">{count}</span> : null}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-spacer" />

        <BackgroundTaskDock />

        <button className="assistant-card" onClick={() => openFeedWorkspace()}>
          <span className="assistant-card-glow" aria-hidden="true" />
          <span className="assistant-orb">
            <Bot size={18} />
          </span>
          <span className="assistant-card-copy">
            <strong>AI feed</strong>
            <small>Put an agent to work</small>
          </span>
          <ArrowUpRight size={16} className="assistant-card-arrow" />
        </button>

        <div className="sync-card">
          <span>
            <strong>{demoMode ? "Preview library" : libraryName.trim() || "My Paper Library"}</strong>
            <small>{demoMode ? "Loading library" : `${snapshot.stats.papers} papers · Local library`}</small>
          </span>
        </div>
      </aside>

      {mobileNav ? <Scrim fixed onClick={closeMobileNavigation} label="Close navigation" className="z-[70] md:hidden" /> : null}

      <main className="app-main" id="main-content" inert={mobileNav ? true : undefined}>
        <header className="topbar">
          <ActionButton variant="ghost" size="icon" className="mobile-menu" onClick={openMobileNavigation} aria-label="Open navigation" icon={<Menu />} />

          <button className="global-search" onClick={() => setCommandOpen(true)}>
            <Search size={17} />
            <span>Search papers, people, venues…</span>
            <span className="shortcut"><Command size={12} /> K</span>
          </button>
          <div className="topbar-actions">
            <ThemeToggle />
          </div>
        </header>

        <section className="workspace">
          <h1 className="view-heading sr-only" tabIndex={-1}>{currentViewLabel}</h1>
          {loading ? (
            <LoadingWorkspace />
          ) : view === "home" ? (
            <Dashboard
              snapshot={snapshot}
              currentPaper={currentPaper}
              openPaper={setSelectedPaper}
              setView={changeView}
              openChat={openFeedWorkspace}
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
              editSelected={() => {
                const paper = snapshot.papers.find((candidate) => candidate.id === selectedPapers[0]);
                if (paper) {
                  setModal({ kind: "edit-paper", paper });
                }
              }}
              deleteSelected={() => void deleteRecords("paper", selectedPapers)}
              exportSelected={() => {
                const selectedIds = new Set(selectedPapers);
                setModal({ kind: "export", papers: snapshot.papers.filter((paper) => selectedIds.has(paper.id)) });
              }}
              updatePaper={updatePaper}
              onOpenAuthor={(authorId, authorName) => { setQuery(""); setLibraryFilters([createLibraryFilter("author", authorId, authorName)]); }}
              onOpenVenue={(venueId, venueLabel) => { setQuery(""); setLibraryFilters([createLibraryFilter("venue", venueId, venueLabel)]); }}
              onOpenCollection={(collectionId, collectionName) => { setQuery(""); setLibraryFilters([createLibraryFilter("collection", collectionId, collectionName)]); }}
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
              onOpenPaper={setSelectedPaper}
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
              onSearchLibrary={() => setCommandOpen(true)}
            />
          ) : (
            <SettingsView notify={notify} theme={theme} onThemeChange={setTheme} libraryName={libraryName} onLibraryNameChange={setLibraryName} papers={snapshot.papers} onEditPaper={(paper) => setModal({ kind: "edit-paper", paper })} />
          )}
        </section>
      </main>

      {selectedPaper ? (
        <PaperDetail
          paper={selectedPaper}
          suspendAutoClose={Boolean(modal)}
          onClose={() => setSelectedPaper(null)}
          onUpdate={updatePaper}
          onChat={() => openFeedWorkspace(selectedPaper)}
          onRead={() => openReaderWorkspace(selectedPaper)}
          onEdit={() => setModal({ kind: "edit-paper", paper: selectedPaper })}
          onExport={() => setModal({ kind: "export", papers: [selectedPaper] })}
          onRevealFile={async (kind, path) => {
            try {
              const response = await fetch("/api/reveal-local-file", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind, path }),
              });
              if (!response.ok) {
                throw new Error(await readError(response));
              }
              notify("Opened the enclosing folder.", "success");
            } catch (error) {
              notify(error instanceof Error ? error.message : "The enclosing folder could not be opened.", "error");
            }
          }}
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

      {modal?.kind === "add-paper" ? (
        <AddPaperModal
          authors={snapshot.authors}
          venues={snapshot.venues}
          collections={snapshot.collections}
          onClose={() => setModal(null)}
          mutateLibrary={mutateLibrary}
          notify={notify}
        />
      ) : null}

      {modal?.kind === "edit-paper" ? (
        <PaperEditModal
          paper={modal.paper}
          authors={snapshot.authors}
          venues={snapshot.venues}
          collections={snapshot.collections}
          onClose={() => setModal(null)}
          mutateLibrary={mutateLibrary}
          notify={notify}
        />
      ) : null}

      {modal?.kind === "export" ? (
        <ExportReferencesModal papers={modal.papers} onClose={() => setModal(null)} />
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

      <div className="sr-only" role="status">{toast && toast.tone !== "error" && toast.tone !== "warning" ? toast.message : ""}</div>
      {toast ? <Toast toast={toast} onDismiss={() => setToast(null)} /> : null}
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
          <span className="stat-icon blue"><Library size={18} /></span>
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
            <p className="card-kicker"><span /> {currentPaper.readingStatus === "reading" ? "Continue reading" : "Latest paper"}</p>
            <h2>{currentPaper.title}</h2>
            <ExpandableAbstract abstract={currentPaper.abstract} />
            <div className="paper-byline">
              {/* The available width—not a fixed author count—decides how many
                  names precede the expansion control. */}
              <AdaptiveAuthors authors={currentPaper.authors} />
              <span className="paper-byline-venue">{venueLine(currentPaper)}{currentPaper.year ? ` · ${currentPaper.year}` : ""}</span>
            </div>
            <div className="continue-actions">
              <ActionButton variant="primary" icon={<ArrowRight size={16} />} onClick={() => openPaper(currentPaper)}>Open paper</ActionButton>
              <ActionButton variant="secondary" icon={<Sparkles size={15} />} onClick={() => openChat(currentPaper)}>Discuss in feed</ActionButton>
            </div>
          </div>
          <div className="continue-visual" aria-hidden="true">
            <div className="document-stack document-back" />
            <div className="document-stack document-middle" />
            <div className="document-sheet">
              <div className="sheet-label">PAPER / {new Date().getFullYear()}</div>
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
            <p className="eyebrow">Reading progress</p>
            <h3>{readingProgress}% read</h3>
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
        <TextButton onClick={() => setView("library")} trailingIcon={<ArrowRight />}>Review reading queue</TextButton>
      </aside>

      <section className="recent-panel">
        <div className="section-title-row">
          <div>
            <p className="eyebrow">Recently added</p>
            <h3>Fresh in your library</h3>
          </div>
          <TextButton onClick={() => setView("library")} trailingIcon={<ArrowRight />}>View all papers</TextButton>
        </div>
        <div className="recent-list">
          {recentPapers.map((paper) => (
            <article className="recent-row" key={paper.id}>
              <span className="type-tile"><FileText size={18} /></span>
              <span className="recent-copy">
                <button type="button" className="recent-title-button" onClick={() => openPaper(paper)}><strong>{paper.title}</strong></button>
                <span className="recent-meta"><AdaptiveAuthors authors={paper.authors} /><span>{venueLine(paper)} {paper.year}</span></span>
              </span>
              <StatusPill className="recent-row-status" status={paper.readingStatus} />
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
  editSelected,
  deleteSelected,
  exportSelected,
  updatePaper,
  onOpenAuthor,
  onOpenVenue,
  onOpenCollection,
}: {
  papers: Paper[];
  query: string;
  setQuery: (value: string) => void;
  filters: LibraryFilterClause[];
  setFilters: (filters: LibraryFilterClause[]) => void;
  selected: string[];
  setSelected: Dispatch<SetStateAction<string[]>>;
  openPaper: (paper: Paper) => void;
  editSelected: () => void;
  deleteSelected: () => void;
  exportSelected: () => void;
  updatePaper: (paper: Paper, data: Record<string, unknown>, message: string) => Promise<void>;
  onOpenAuthor: (authorId: string, authorName: string) => void;
  onOpenVenue: (venueId: string, venueLabel: string) => void;
  onOpenCollection: (collectionId: string, collectionName: string) => void;
}) {
  const [status, setStatus] = useState("all");
  const [filterKind, setFilterKind] = useState<LibraryFilterKind>("collection");
  const [filterValue, setFilterValue] = useState("");
  const [filterBuilderOpen, setFilterBuilderOpen] = useState(false);
  const [sort, setSort] = useState<PaperSort>(DEFAULT_PAPER_SORT);
  const { widths: columnWidths, resizeColumn, resetColumnWidth } = useResizableColumns<PaperColumnKey>(
    "stacks-paper-grid-widths-v4",
    defaultPaperColumnWidths,
    // Minimum pixel widths. Venue holds a short acronym over a type label, so it
    // shrinks well below the old 140px floor, which made the column feel stuck
    // partway through a drag.
    { title: 220, venue: 76, year: 72, status: 72 },
    // Only Paper and Venue carry handles; checkbox, status, and year are fixed.
    ["title", "venue"],
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (filters.length > 0) {
        setFilterBuilderOpen(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [filters.length]);

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

  // Keep the selection confined to currently-visible papers. Without this, a
  // search/status/filter change can hide selected rows while the toolbar still
  // counts them, so bulk Delete/Export would act on papers not on screen. Prune
  // whenever the filtered set changes; only write when something actually drops.
  useEffect(() => {
    const visible = new Set(filtered.map((paper) => paper.id));
    setSelected((current) => {
      const pruned = current.filter((id) => visible.has(id));
      return pruned.length === current.length ? current : pruned;
    });
    // filtered is derived from query/status/filters/papers/sort; keying on its
    // ids prunes on any of those changes without over-firing on re-sorts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);
  const filterOptions = useMemo<Record<LibraryFilterKind, LibraryFilterOption[]>>(() => {
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
  // Floors only. The resize handler already enforces per-column minimum pixel
  // widths and caps, and it keeps the two shares summing to a constant; clamping
  // the venue share to a ceiling here as well used to silently discard part of a
  // drag, so the column stopped following the cursor partway through.
  // The two resizable columns divide the space the fixed ones leave, so their
  // `<col>` percentages are normalized against each other.
  const paperResizableTotal = columnWidths.title + columnWidths.venue;

  /**
   * Cycle a column: ascending, descending, then back to the library's default
   * order (most recently added first). Without the third step the default is
   * unreachable once any header has been clicked, since no header represents it.
   */
  function toggleSort(key: PaperColumnKey) {
    setSort((current) => cycleTableSort(current, key, DEFAULT_PAPER_SORT, (candidate) => candidate === "year"));
  }

  const sortIsDefault = sort.key === DEFAULT_PAPER_SORT.key && sort.direction === DEFAULT_PAPER_SORT.direction;

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
        <button type="button" className={`filter-builder-toggle ${filterBuilderOpen ? "is-open" : ""} ${filters.length ? "has-filters" : ""}`} onClick={() => setFilterBuilderOpen((current) => !current)} aria-expanded={filterBuilderOpen} aria-pressed={filterBuilderOpen} title={filterBuilderOpen ? "Close library filters" : "Build library filters"}><ListFilter size={16} /><span>Filters</span>{filters.length ? <b>{filters.length}</b> : null}</button>
        {/* Only shown while a column sort is active, since it does nothing at
            rest and the default order has no header of its own to click. */}
        {sortIsDefault ? null : (
          <button type="button" className="sort-reset-button" onClick={() => { setSort(DEFAULT_PAPER_SORT); setPage(1); }} title="Sort by date added again">
            <ArrowDownUp size={15} /><span>Reset sort</span>
          </button>
        )}
        <div className="filter-tabs">
          {["all", "inbox", "reading", "complete", "favorite"].map((item) => (
            <TabButton key={item} variant="pill" active={status === item} onClick={() => { setStatus(item); setPage(1); }}>
              {item === "all" ? "All" : item === "favorite" ? "Starred" : statusLabel(item)}
            </TabButton>
          ))}
        </div>
        {selected.length ? (
          <div className="library-selection-actions">
            <span><CheckCircle2 size={15} /> {selected.length} selected</span>
            {selected.length === 1 ? <ActionButton variant="ghost" size="small" onClick={editSelected} icon={<Pencil />}>Edit</ActionButton> : null}
            <ActionButton variant="ghost" size="small" onClick={exportSelected} icon={<Download />}>Export</ActionButton>
            <ActionButton variant="ghost" size="small" onClick={() => setSelected([])} icon={<X />}>Clear</ActionButton>
            <ActionButton variant="danger" size="small" onClick={deleteSelected} icon={<Trash2 />}>Delete</ActionButton>
          </div>
        ) : null}
      </div>

      {filterBuilderOpen ? (
        <section className="filter-builder-panel" aria-label="Library filter expression">
          <header><span><ListFilter size={15} /><strong>Filter expression</strong></span>{filters.length ? <button type="button" onClick={() => { setFilters([]); setPage(1); }}><X size={14} /> Clear all</button> : null}</header>
          <div className="filter-clause-list">
            {filters.map((clause, index) => (
              <div className="filter-clause-row" key={clause.key}>
                {index ? <Select className="filter-clause-select" size="small" ariaLabel={`Relationship before ${clause.label}`} value={clause.join} onChange={(next) => updateFilter(clause.key, { join: next as LibraryFilterJoin })} options={[{ value: "AND", label: "AND" }, { value: "OR", label: "OR" }]} /> : <span className="filter-start">WHERE</span>}
                <button type="button" className={clause.openGroups ? "is-active" : ""} onClick={() => updateFilter(clause.key, { openGroups: (clause.openGroups + 1) % 3 })} aria-label="Add opening parenthesis">{clause.openGroups ? "(".repeat(clause.openGroups) : "("}</button>
                <button type="button" className={clause.negated ? "is-active" : ""} onClick={() => updateFilter(clause.key, { negated: !clause.negated })} aria-pressed={clause.negated}>NOT</button>
                <Select className="filter-clause-select" size="small" ariaLabel={`Field for ${clause.label}`} value={clause.kind} onChange={(next) => changeFilterKind(clause, next as LibraryFilterKind)} options={[{ value: "collection", label: "Collection" }, { value: "author", label: "Author" }, { value: "venue", label: "Venue" }, { value: "year", label: "Year" }]} />
                <span>=</span>
                <FilterValueCombobox
                  kind={clause.kind}
                  options={filterOptions[clause.kind]}
                  valueId={clause.valueId}
                  fallbackLabel={clause.label}
                  ariaLabel={`Value for ${clause.kind}`}
                  onSelect={(option) => updateFilter(clause.key, { valueId: option.id, label: option.label })}
                  onClear={() => updateFilter(clause.key, { valueId: "", label: "" })}
                />
                <button type="button" className={clause.closeGroups ? "is-active" : ""} onClick={() => updateFilter(clause.key, { closeGroups: (clause.closeGroups + 1) % 3 })} aria-label="Add closing parenthesis">{clause.closeGroups ? ")".repeat(clause.closeGroups) : ")"}</button>
                <button type="button" className="is-danger" onClick={() => { setFilters(filters.filter((candidate) => candidate.key !== clause.key)); setPage(1); }} aria-label={`Remove ${clause.kind} filter`}><Trash2 size={14} /></button>
              </div>
            ))}
            <div className="filter-clause-row filter-clause-add">
              <span className="filter-start">ADD</span>
              <Select className="filter-clause-select" size="small" ariaLabel="New filter field" value={filterKind} onChange={(next) => { setFilterKind(next as LibraryFilterKind); setFilterValue(""); }} options={[{ value: "collection", label: "Collection" }, { value: "author", label: "Author" }, { value: "venue", label: "Venue" }, { value: "year", label: "Year" }]} />
              <span>=</span>
              <FilterValueCombobox
                kind={filterKind}
                options={filterOptions[filterKind]}
                valueId={filterValue}
                ariaLabel={`New ${filterKind} filter value`}
                onSelect={(option) => setFilterValue(option.id)}
                onClear={() => setFilterValue("")}
              />
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
              <col className="paper-column-status" />
              <col style={{ width: `${(columnWidths.title / paperResizableTotal) * 100}%` }} />
              <col style={{ width: `${(columnWidths.venue / paperResizableTotal) * 100}%` }} />
              <col className="paper-column-year" />
            </colgroup>
            <thead>
              <tr>
                <th className="check-cell" scope="col">
                  <button onClick={toggleAll} aria-label="Select all visible papers">
                    <SelectionBox checked={Boolean(pagedPapers.length) && pagedPapers.every((paper) => selected.includes(paper.id))} />
                  </button>
                </th>
                <SortableTableHeader label="Status" columnKey="status" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} centered resizable={false} />
                <SortableTableHeader label="Paper" columnKey="title" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
                <SortableTableHeader label="Venue" columnKey="venue" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
                <SortableTableHeader label="Year" columnKey="year" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} centered resizable={false} />
              </tr>
            </thead>
            <tbody>
              {pagedPapers.map((paper) => (
                <tr
                  key={paper.id}
                  className={`${selected.includes(paper.id) ? "is-selected" : ""} ${paper.collections.length ? "has-collections" : ""}`.trim()}
                  onClick={() => openPaper(paper)}
                >
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
                  <td className="status-cell"><StatusPill status={paper.readingStatus} compact /></td>
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
                        <button
                          type="button"
                          className="paper-title-open"
                          onClick={(event) => { event.stopPropagation(); openPaper(paper); }}
                        >
                          <strong>{paper.title}</strong>
                        </button>
                        {/* These lines stretch the full column width, so they
                            must not swallow clicks on their empty space: only a
                            click that landed on an actual control (an author
                            name, the show-more toggle, a chip) is kept from
                            reaching the row. */}
                        <span className="paper-secondary-line" onClick={stopIfInteractive}>
                          <AdaptiveAuthors authors={paper.authors} onOpenAuthor={(authorName) => { const author = paper.authors.find((candidate) => candidate.displayName === authorName); if (author) onOpenAuthor(author.id, author.displayName); }} />
                        </span>
                        {paper.collections.length ? (
                          <span className="paper-collection-line" aria-label="Collections" onClick={stopIfInteractive}>
                            {paper.collections.slice(0, 3).map((collection) => (
                              <CollectionChip key={collection.id} size="small" name={collection.name} color={collection.color} onClick={() => onOpenCollection(collection.id, collection.name)} />
                            ))}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </td>
                  {/* The cell shows the acronym, so the tooltip spells the venue out.
                      Only when both are recorded and differ: otherwise it would just
                      repeat the text already in the cell. */}
                  <td>
                    {paper.venueId ? (
                      <button
                        type="button"
                        className="venue-cell venue-cell-open"
                        title={venueFullNameHint(paper)}
                        onClick={(event) => { event.stopPropagation(); onOpenVenue(paper.venueId!, venueLine(paper)); }}
                      >
                        <b>{paper.venueAcronym || paper.venueName}</b><small>{paper.paperType}</small>
                      </button>
                    ) : (
                      <span className="venue-cell" title={venueFullNameHint(paper)}><b>{paper.venueAcronym || paper.venueName || "—"}</b><small>{paper.paperType}</small></span>
                    )}
                  </td>
                  <td className="muted-cell year-cell">{paper.year ?? "—"}</td>
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
        <EmptyState
          icon={<Search size={24} />}
          title={papers.length ? "No papers found" : "No papers yet"}
          detail={papers.length ? "Try another search or clear the current filters." : "Add a paper to start building your research library."}
          action={query || filters.length ? <ActionButton size="small" onClick={() => { setQuery(""); setFilters([]); }}>Clear search and filters</ActionButton> : undefined}
        />
      )}
    </div>
  );
}

interface PaperSort {
  key: "recent" | "title" | "venue" | "year" | "status";
  direction: "asc" | "desc";
}

/** The library's resting order: most recently added first. Reachable again by
 *  cycling any sorted column past its second click. */
const DEFAULT_PAPER_SORT: PaperSort = { key: "recent", direction: "desc" };

/** Resting orders for the entity tables: alphabetical by name. */
const DEFAULT_AUTHOR_SORT: TableSort<AuthorColumnKey> = { key: "author", direction: "asc" };
const DEFAULT_VENUE_SORT: TableSort<VenueColumnKey> = { key: "venue", direction: "asc" };

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
  const [sort, setSort] = useState<TableSort<AuthorColumnKey>>(DEFAULT_AUTHOR_SORT);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  // The authors table has no draggable column: the name takes whatever the two
  // fixed-width count columns leave, so there is nothing to store or restore.
  const { resizeColumn, resetColumnWidth } = useResizableColumns<AuthorColumnKey>(
    "stacks-author-grid-widths-v4",
    defaultAuthorColumnWidths,
    { author: 260, papers: 80, latest: 80 },
    [],
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
  function toggleSort(key: typeof sort.key) {
    setSort((current) => cycleTableSort(current, key, DEFAULT_AUTHOR_SORT, (candidate) => candidate === "papers" || candidate === "latest"));
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
            <col style={{ width: "100%" }} />
            <col style={{ width: "84px" }} />
            <col style={{ width: "84px" }} />
            <col className="entity-column-actions" />
          </colgroup>
          <thead>
            <tr>
              <th className="check-cell" scope="col">
                <button onClick={toggleAll} aria-label="Select all visible authors">
                  <SelectionBox checked={Boolean(pagedAuthors.length) && pagedAuthors.every((author) => selected.includes(author.id))} />
                </button>
              </th>
              <SortableTableHeader label="Author" columnKey="author" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} resizable={false} />
              <SortableTableHeader label="Papers" columnKey="papers" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} centered resizable={false} />
              <SortableTableHeader label="Latest" columnKey="latest" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} centered resizable={false} />
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
                <td className="actions-cell"><ActionButton variant="ghost" size="icon-small" onClick={() => onEdit(author)} icon={<Pencil />} aria-label={`Edit ${author.displayName}`} /></td>
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
      {!filtered.length ? (
        <EmptyState
          icon={<UsersRound size={24} />}
          title={authors.length ? "No authors found" : "No authors yet"}
          detail={authors.length ? "Try another author name." : "Add an author to keep names consistent across papers."}
          action={<ActionButton size="small" onClick={query ? () => setQuery("") : onCreate}>{query ? "Clear author search" : "Add author"}</ActionButton>}
        />
      ) : null}
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
  const [sort, setSort] = useState<TableSort<VenueColumnKey>>(DEFAULT_VENUE_SORT);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const { widths, resizeColumn, resetColumnWidth } = useResizableColumns<VenueColumnKey>(
    "stacks-venue-grid-widths-v4",
    defaultVenueColumnWidths,
    { venue: 220, type: 100, publisher: 150, papers: 80, latest: 80 },
    // Only the name and publisher are draggable; type and the counts are fixed.
    ["venue", "publisher"],
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
  const venueResizableTotal = widths.venue + widths.publisher;
  function toggleSort(key: typeof sort.key) {
    setSort((current) => cycleTableSort(current, key, DEFAULT_VENUE_SORT, (candidate) => candidate === "papers" || candidate === "latest"));
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
            <col style={{ width: `${(widths.venue / venueResizableTotal) * 100}%` }} />
            <col style={{ width: "112px" }} />
            <col style={{ width: `${(widths.publisher / venueResizableTotal) * 100}%` }} />
            <col style={{ width: "84px" }} />
            <col style={{ width: "84px" }} />
            <col className="entity-column-actions" />
          </colgroup>
          <thead>
            <tr>
              <th className="check-cell" scope="col">
                <button onClick={toggleAll} aria-label="Select all visible venues">
                  <SelectionBox checked={Boolean(pagedVenues.length) && pagedVenues.every((venue) => selected.includes(venue.id))} />
                </button>
              </th>
              <SortableTableHeader label="Venue" columnKey="venue" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
              <SortableTableHeader label="Type" columnKey="type" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} resizable={false} />
              <SortableTableHeader label="Publisher" columnKey="publisher" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} />
              <SortableTableHeader label="Papers" columnKey="papers" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} centered resizable={false} />
              <SortableTableHeader label="Latest" columnKey="latest" sort={sort} onSort={toggleSort} onResize={resizeColumn} onResetWidth={resetColumnWidth} centered resizable={false} />
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
                    <span className="venue-monogram">{venueMonogram(venue)}</span>
                    <span><strong>{venue.name}</strong><small>{venue.acronym || "No acronym"}</small></span>
                  </button>
                </td>
                <td className="entity-meta-cell entity-type-cell">{venue.type}</td>
                <td className="entity-meta-cell">{venue.publisher || "—"}</td>
                <td className="entity-number-cell">{venue.paperCount}</td>
                <td className="entity-number-cell">{venue.latestYear ?? "—"}</td>
                <td className="actions-cell"><ActionButton variant="ghost" size="icon-small" onClick={() => onEdit(venue)} icon={<Pencil />} aria-label={`Edit ${venue.name}`} /></td>
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
      {!filtered.length ? (
        <EmptyState
          icon={<Building2 size={24} />}
          title={venues.length ? "No venues found" : "No venues yet"}
          detail={venues.length ? "Try a different conference, journal, or publisher." : "Add a venue to keep publication details consistent."}
          action={<ActionButton size="small" onClick={query ? () => setQuery("") : onCreate}>{query ? "Clear venue search" : "Add venue"}</ActionButton>}
        />
      ) : null}
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
  onOpenPaper,
}: {
  collections: Collection[];
  papers: Paper[];
  query: string;
  setQuery: (value: string) => void;
  onEdit: (collection: Collection) => void;
  onDelete: (collection: Collection) => void;
  onCreate: () => void;
  onOpen: (collection: Collection) => void;
  onOpenPaper: (paper: Paper) => void;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(6);
  const filtered = collections.filter((collection) => matchesSearch([collection.name], query));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pagedCollections = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  return (
    <div className="data-view collections-view">
      <div className="view-toolbar compact-toolbar"><PageSearch value={query} onChange={(value) => { setQuery(value); setPage(1); }} placeholder="Search collections…" /><ToolbarCreateButton label="Add collection" onClick={onCreate} /></div>
      {filtered.length ? (
        <TablePagination
          page={currentPage}
          pageSize={pageSize}
          total={filtered.length}
          itemLabel="collections"
          pageSizeOptions={[6, 9, 12]}
          pageSizeLabel="Collections"
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        />
      ) : null}
      <div className="collection-grid">
        {pagedCollections.map((collection) => (
          <CollectionCard
            collection={collection}
            papers={papers.filter((paper) => paper.collections.some((paperCollection) => paperCollection.id === collection.id))}
            onEdit={() => onEdit(collection)}
            onDelete={() => onDelete(collection)}
            onOpen={() => onOpen(collection)}
            onOpenPaper={onOpenPaper}
            key={collection.id}
          />
        ))}
      </div>
      {filtered.length ? (
        <TablePagination
          page={currentPage}
          pageSize={pageSize}
          total={filtered.length}
          itemLabel="collections"
          pageSizeOptions={[6, 9, 12]}
          pageSizeLabel="Collections"
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        />
      ) : null}
      {!filtered.length ? (
        <EmptyState
          icon={<FolderOpen size={24} />}
          title={collections.length ? "No collections found" : "No collections yet"}
          detail="Collections keep related papers together."
          action={<ActionButton size="small" onClick={query ? () => setQuery("") : onCreate}>{query ? "Clear collection search" : "Add collection"}</ActionButton>}
        />
      ) : null}
    </div>
  );
}

function CollectionCard({ collection, papers, onEdit, onDelete, onOpen, onOpenPaper }: {
  collection: Collection;
  papers: Paper[];
  onEdit: () => void;
  onDelete: () => void;
  onOpen: () => void;
  onOpenPaper: (paper: Paper) => void;
}) {
  const pageSize = 4;
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(papers.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visiblePapers = papers.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const start = papers.length ? (currentPage - 1) * pageSize + 1 : 0;
  const end = Math.min(currentPage * pageSize, papers.length);

  // Reading progress, shown as a bar rather than a "0 of 21 read" line that told
  // the user nothing in the common case where nothing is read yet.
  const readCount = papers.filter((paper) => paper.readingStatus === "complete").length;
  const readPercent = papers.length ? Math.round((readCount / papers.length) * 100) : 0;

  // The years the collection spans. Deliberately NOT a "most common venue": on a
  // collection of preprints that is always "arXiv", which says nothing about the
  // collection and reads as though the whole set were published there.
  const years = papers.map((paper) => paper.year).filter((year): year is number => typeof year === "number");
  const yearSpan = years.length
    ? (Math.min(...years) === Math.max(...years) ? String(Math.min(...years)) : `${Math.min(...years)}–${Math.max(...years)}`)
    : "";

  return (
    <article className="collection-card">
      <header className="collection-card-top">
        <button type="button" className="collection-heading" onClick={onOpen}>
          <span className={`collection-icon swatch-${collection.color}`}><FolderOpen size={16} /></span>
          <span>
            <strong>{collection.name}</strong>
            <small>
              {collection.paperCount} {collection.paperCount === 1 ? "paper" : "papers"}
              {yearSpan ? ` · ${yearSpan}` : ""}
            </small>
          </span>
        </button>
        <div className="collection-actions">
          {/* The tooltip names the collection, like the aria-label: a bare "Edit"
              adds nothing that the pencil icon does not already say. */}
          <ActionButton variant="secondary" size="icon-small" onClick={onEdit} icon={<Pencil />} aria-label={`Edit ${collection.name}`} />
          <ActionButton variant="danger" size="icon-small" onClick={onDelete} icon={<Trash2 />} aria-label={`Delete ${collection.name}`} />
        </div>
      </header>
      {/* Always present, so every card has the same structure and therefore the
          same height, and so "nothing read yet" is stated rather than implied by
          an absent row. */}
      {/* The exact counts, which the percentage beside it does not give. */}
      <div className="collection-progress" title={`${readCount} of ${papers.length} papers read`}>
        <span className="collection-progress-track">
          <span className="collection-progress-fill" style={{ width: `${readPercent}%` }} />
        </span>
        <small>{readCount ? `${readPercent}% read` : "None read"}</small>
      </div>
      <ul className="collection-papers" aria-label={`Papers in ${collection.name}`}>
        {visiblePapers.map((paper) => (
          <li key={paper.id}>
            <button type="button" onClick={() => onOpenPaper(paper)} title={paper.title}>
              {/* The title wraps to a second line instead of being cut mid-word,
                  which is what made these cards unreadable. */}
              <span className="collection-paper-title">{paper.title}</span>
              {/* Up to three names, like the paper detail panel, then "+N". */}
              <small className="collection-paper-meta">{paperMetaLine(paper)}</small>
            </button>
          </li>
        ))}
        {!papers.length ? (
          <li className="collection-papers-empty"><FileText size={14} /><span>No papers in this collection</span></li>
        ) : null}
      </ul>
      {papers.length > pageSize ? (
        <div className="collection-card-pagination">
          <span>{start}-{end} of {papers.length}</span>
          <PaginationPageNav
            page={currentPage}
            pageCount={pageCount}
            onPageChange={setPage}
            label={`${collection.name} paper pages`}
            className="collection-card-page-nav"
            iconSize={13}
          />
        </div>
      ) : null}
    </article>
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
          <span><CheckCircle2 size={15} /> {selected} selected</span>
          <ActionButton variant="ghost" size="small" onClick={onBulk} icon={<Pencil />}>Edit</ActionButton>
          <ActionButton variant="ghost" size="small" onClick={onClear} icon={<X />}>Clear</ActionButton>
          <ActionButton variant="danger" size="small" onClick={onDelete} icon={<Trash2 />}>Delete</ActionButton>
        </div>
      ) : null}
      <ToolbarCreateButton label={createLabel} onClick={onCreate} />
    </div>
  );
}

function ToolbarCreateButton({ label, onClick }: { label: string; onClick: () => void }) {
  // No `title`: the label is already the button's visible text, so a tooltip
  // repeating it says nothing.
  return <ActionButton variant="primary" className="toolbar-add-action ml-auto" onClick={onClick} aria-label={label} icon={<Plus />}>{label}</ActionButton>;
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
      {value ? <button type="button" onClick={() => onChange("")} aria-label="Clear search"><X size={14} /></button> : null}
    </label>
  );
}

function FilterValueCombobox({ kind, options, valueId, fallbackLabel = "", ariaLabel, onSelect, onClear }: {
  kind: LibraryFilterKind;
  options: LibraryFilterOption[];
  valueId: string;
  fallbackLabel?: string;
  ariaLabel: string;
  onSelect: (option: LibraryFilterOption) => void;
  onClear: () => void;
}) {
  const listboxId = useId();
  const selectedLabel = options.find((option) => option.id === valueId)?.label ?? (valueId ? fallbackLabel : "");
  const [query, setQuery] = useState(selectedLabel);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const synchronizedValue = useRef(valueId);
  const normalizedQuery = query.trim().toLowerCase();
  const matchingOptions = options
    .filter((option) => !normalizedQuery || option.label.toLowerCase().includes(normalizedQuery))
    .slice(0, 8);

  useEffect(() => {
    if (synchronizedValue.current === valueId) {
      return;
    }
    synchronizedValue.current = valueId;
    setQuery(selectedLabel);
    setActiveIndex(0);
  }, [selectedLabel, valueId]);

  function chooseOption(option: LibraryFilterOption) {
    synchronizedValue.current = option.id;
    setQuery(option.label);
    setOpen(false);
    setActiveIndex(0);
    onSelect(option);
  }

  return (
    <div
      className={`filter-value-combobox ${open ? "is-open" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <Search size={13} aria-hidden="true" />
      <input
        value={query}
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && matchingOptions[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined}
        placeholder={`Search ${ENTITY_PLURALS[kind] ?? "years"}…`}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          const nextQuery = event.target.value;
          setQuery(nextQuery);
          setOpen(true);
          setActiveIndex(0);
          if (valueId && nextQuery !== selectedLabel) {
            synchronizedValue.current = "";
            onClear();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((current) => Math.min(current + 1, Math.max(0, matchingOptions.length - 1)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((current) => Math.max(0, current - 1));
          } else if (event.key === "Enter" && open && matchingOptions[activeIndex]) {
            event.preventDefault();
            chooseOption(matchingOptions[activeIndex]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      <ChevronDown size={13} aria-hidden="true" />
      {open ? (
        <div className="filter-value-options" id={listboxId} role="listbox" aria-label={`${kind} matches`}>
          {matchingOptions.length ? matchingOptions.map((option, index) => (
            <button
              type="button"
              id={`${listboxId}-option-${index}`}
              role="option"
              aria-selected={option.id === valueId}
              className={`${index === activeIndex ? "is-active" : ""} ${option.id === valueId ? "is-selected" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => chooseOption(option)}
              key={option.id}
            >
              <span>{option.label}</span>
              {option.id === valueId ? <Check size={13} /> : null}
            </button>
          )) : <span className="filter-value-empty">No matching {kind === "author" ? "authors" : "venues"}</span>}
        </div>
      ) : null}
    </div>
  );
}

function buildPageWindow(page: number, pageCount: number, windowSize = 5) {
  const normalizedCount = Math.max(1, pageCount);
  const normalizedPage = Math.min(normalizedCount, Math.max(1, page));
  const visibleCount = Math.min(Math.max(1, windowSize), normalizedCount);
  const centeredStart = normalizedPage - Math.floor(visibleCount / 2);
  const start = Math.max(1, Math.min(centeredStart, normalizedCount - visibleCount + 1));
  return Array.from({ length: visibleCount }, (_, index) => start + index);
}

function PaginationPageNav({ page, pageCount, onPageChange, label, className, windowSize = 5, iconSize = 15 }: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  label: string;
  className?: string;
  windowSize?: number;
  iconSize?: number;
}) {
  const normalizedCount = Math.max(1, pageCount);
  const currentPage = Math.min(normalizedCount, Math.max(1, page));
  const visiblePages = buildPageWindow(currentPage, normalizedCount, windowSize);
  const compact = iconSize <= 13;
  return (
    <nav className={cx("flex items-center gap-1", className)} aria-label={label}>
      <PaginationButton compact={compact} onClick={() => onPageChange(1)} disabled={currentPage <= 1} aria-label="First page"><ChevronsLeft size={iconSize} /></PaginationButton>
      {visiblePages.map((visiblePage) => (
        <PaginationButton
          compact={compact}
          current={visiblePage === currentPage}
          aria-current={visiblePage === currentPage ? "page" : undefined}
          onClick={() => onPageChange(visiblePage)}
          key={visiblePage}
        >
          {visiblePage}
        </PaginationButton>
      ))}
      <PaginationButton compact={compact} onClick={() => onPageChange(normalizedCount)} disabled={currentPage >= normalizedCount} aria-label="Last page"><ChevronsRight size={iconSize} /></PaginationButton>
    </nav>
  );
}

function TablePagination({ page, pageSize, total, itemLabel, pageSizeOptions = [10, 25, 50], pageSizeLabel = "Rows", onPageChange, onPageSizeChange }: {
  page: number;
  pageSize: number;
  total: number;
  itemLabel: string;
  pageSizeOptions?: number[];
  pageSizeLabel?: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(pageCount, Math.max(1, page));
  const start = total ? (currentPage - 1) * pageSize + 1 : 0;
  const end = Math.min(currentPage * pageSize, total);
  function jump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const target = Math.min(pageCount, Math.max(1, Number(form.get("page")) || 1));
    onPageChange(target);
  }
  return (
    <div className="table-pagination">
      <span>Showing {start}-{end} of {total} {itemLabel}</span>
      <div className="table-pagination-controls">
        <div className="page-size-control">
          <span>{pageSizeLabel}</span>
          <details className="page-size-picker">
            <summary aria-label={`${pageSizeLabel} per page for ${itemLabel}`}><span>{pageSize}</span><ChevronDown size={15} /></summary>
            <div className="page-size-menu" role="menu">
              {pageSizeOptions.map((size) => (
                <button
                  type="button"
                  className={size === pageSize ? "is-selected" : ""}
                  role="menuitemradio"
                  aria-checked={size === pageSize}
                  onClick={(event) => {
                    onPageSizeChange(size);
                    event.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                  key={size}
                >
                  <span>{size}</span>{size === pageSize ? <Check size={14} /> : null}
                </button>
              ))}
            </div>
          </details>
        </div>
        <PaginationPageNav page={currentPage} pageCount={pageCount} onPageChange={onPageChange} label={`${itemLabel} pages`} className="pagination-pages" />
        <form className="pagination-jump" onSubmit={jump}>
          <span>Pages: {currentPage}/{pageCount}</span>
          <input key={currentPage} name="page" type="number" min="1" max={pageCount} defaultValue={currentPage} aria-label={`Go to ${itemLabel} page`} />
          <PaginationButton type="submit">Go</PaginationButton>
        </form>
      </div>
    </div>
  );
}

function DiscoverView({ mutateLibrary, notify, onImport, onSearchLibrary }: {
  mutateLibrary: (body: MutationBody, successMessage: string) => Promise<boolean>;
  notify: (message: string, tone?: ToastState["tone"]) => void;
  onImport: () => void;
  onSearchLibrary: () => void;
}) {
  const { runTask } = useBackgroundTasks();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<DiscoveryProvider>("semantic-scholar");
  const [results, setResults] = useState<DiscoveryResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);

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
      setPage(1);
      if (!payload.results.length) {
        notify("No matching papers found.", "info");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "Discovery search failed.", "error");
    } finally {
      setLoading(false);
    }
  }

  function addResult(result: DiscoveryResult) {
    // Mark the row added immediately, then acquire the source (a slow PDF/HTML
    // download) and create the paper in the background dock — the UI never
    // blocks on the fetch, matching PaperCLI's async import.
    setAdded((current) => [...current, result.sourceId || result.title]);
    void runTask(`Add paper · ${result.title}`, async () => {
      let paperData: Record<string, unknown> = { ...result };
      if (hasAcquirableSource(paperData)) {
        try {
          paperData = withAcquiredSource(paperData, await acquirePaperSource(paperData));
        } catch (error) {
          notify(`The paper will still be added, but its file couldn't be saved: ${error instanceof Error ? error.message : "download failed"}`, "info");
        }
      }
      const succeeded = await mutateLibrary(
        { entity: "paper", action: "create", data: paperData },
        "Paper added to your library.",
      );
      if (!succeeded) {
        // Roll back the optimistic "Added" marker so the user can retry.
        setAdded((current) => current.filter((id) => id !== (result.sourceId || result.title)));
        throw new Error("The paper could not be added.");
      }
    }).catch(() => {});
  }

  const pageCount = Math.max(1, Math.ceil(results.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pagedResults = results.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <div className="discover-view">
      <form className="discover-search" onSubmit={search}>
        <div className="provider-switch">
          <span>Search in</span>
          {discoveryProviders.map((item) => (
            <TabButton
              variant="pill"
              active={provider === item.id}
              onClick={() => { setProvider(item.id); setPage(1); }}
              key={item.id}
            >
              {item.label}
            </TabButton>
          ))}
        </div>
        <div className="discover-search-box">
          <Search size={21} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a topic, title, DOI, or researcher" autoFocus />
          {/* The shared action, not a hand-rolled copy of it: the bespoke button had
              drifted to its own height, so the same 16px radius read as a rounded
              rectangle here and as a capsule on every button beside it. */}
          <ActionButton
            type="submit"
            variant="primary"
            disabled={loading || !query.trim()}
            icon={loading ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />}
          >Search</ActionButton>
        </div>
      </form>

      {!results.length && !loading ? (
        <div className="discovery-intro">
          <div className="discovery-orbit"><span /><span /><span /><Sparkles size={28} /></div>
          <h2>Search beyond your library.</h2>
          <p>Authors, links, and IDs are kept intact.</p>
          <div className="prompt-suggestions">
            {["long-context retrieval agents", "human AI literature review", "scholarly knowledge graphs"].map((suggestion) => (
              <Chip key={suggestion} tone="neutral" onClick={() => setQuery(suggestion)} icon={<WandSparkles />}>{suggestion}</Chip>
            ))}
          </div>
          <div className="discovery-capabilities">
            <SelectCard onClick={onSearchLibrary} icon={<Search />} title="Search your library" description="Search by title, abstract, author, venue, or notes." trailing={<ArrowRight />} />
            <SelectCard onClick={onImport} icon={<Database />} title="Import by source" description="arXiv, DOI, DBLP, OpenReview, a URL or PDF, or type it in yourself." trailing={<ArrowRight />} />
          </div>
        </div>
      ) : null}

      {loading ? <div className="result-loading"><LoaderCircle className="spin" /><p>Searching {providerLabel(provider)}…</p></div> : null}

      {results.length ? (
        <div className="discovery-results">
          <div className="results-heading"><span>{results.length} results</span><small>from {results[0]?.source}</small></div>
          <TablePagination
            page={currentPage}
            pageSize={pageSize}
            total={results.length}
            itemLabel="results"
            pageSizeOptions={[5, 10, 20]}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
          />
          {pagedResults.map((result) => {
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
                <ActionButton variant={isAdded ? "success" : "primary"} size="small" className="self-start" disabled={isAdded} onClick={() => void addResult(result)} aria-label={isAdded ? `${result.title} added` : `Add ${result.title}`} icon={isAdded ? <Check /> : <Plus />}>
                  {isAdded ? "Added" : "Add"}
                </ActionButton>
              </article>
            );
          })}
          <TablePagination
            page={currentPage}
            pageSize={pageSize}
            total={results.length}
            itemLabel="results"
            pageSizeOptions={[5, 10, 20]}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
          />
        </div>
      ) : null}
    </div>
  );
}

function PaperDetail({ paper, suspendAutoClose, onClose, onUpdate, onChat, onRead, onEdit, onExport, onRevealFile, onDelete, onOpenAuthor, onOpenVenue, onOpenCollection }: {
  paper: Paper;
  suspendAutoClose: boolean;
  onClose: () => void;
  onUpdate: (paper: Paper, data: Record<string, unknown>, message: string) => Promise<void>;
  onChat: () => void;
  onRead: () => void;
  onEdit: () => void;
  onExport: () => void;
  onRevealFile: (kind: "pdf" | "html", path: string) => Promise<void>;
  onDelete: () => void;
  onOpenAuthor: (authorName: string) => void;
  onOpenVenue: () => void;
  onOpenCollection: (collectionId: string, collectionName: string) => void;
}) {
  const hasViewer = Boolean(paper.pdfViewUrl || paper.htmlUrl);
  const detailPanelRef = useRef<HTMLElement>(null);
  const detailTitleId = useId();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const appShellRef = useRef<HTMLElement | null>(null);
  const appShellWasInertRef = useRef(false);
  const detailTabListRef = useRef<HTMLDivElement>(null);
  const { runTask, tasks } = useBackgroundTasks();
  const [summarizing, setSummarizing] = useState(false);
  const [notesDraft, setNotesDraft] = useState(paper.notes);
  const [activeDetailTab, setActiveDetailTab] = useState<"summary" | "abstract" | "notes">("summary");
  const detailTabsId = useId();
  const summaryTaskKey = `summary:${paper.id}`;
  const summaryRunning = summarizing || tasks.some((task) => task.key === summaryTaskKey && task.status === "running");
  useEffect(() => { setNotesDraft(paper.notes); }, [paper.id, paper.notes]);

  const detailTabs = ["summary", "abstract", "notes"] as const;

  function handleDetailTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = detailTabs.indexOf(activeDetailTab);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? detailTabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + detailTabs.length) % detailTabs.length;
    const nextTab = detailTabs[nextIndex];
    setActiveDetailTab(nextTab);
    requestAnimationFrame(() => {
      detailTabListRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${detailTabsId}-${nextTab}-tab`)}`)?.focus();
    });
  }

  async function generateSummary() {
    if (summaryRunning) return;
    setSummarizing(true);
    try {
      await runTask(`Generate summary · ${paper.title}`, async (log) => {
        await withSummarySlot(async () => {
          log.step("Generating the summary.");
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
                localPath: paper.localPath,
              },
            }),
          });
          if (!response.ok) throw new Error(await readError(response));
          const payload = await response.json() as { summary: string; grounding?: SummaryGrounding };
          log.step(groundingNote(payload.grounding));
          log.step("Saving the generated summary.");
          await onUpdate(paper, { summary: payload.summary }, summarySavedMessage(payload.grounding));
        }, () => log.step("Waiting for an available summary slot."));
      }, { key: summaryTaskKey });
    } catch {
      // runTask surfaces the failure in the Activity dock.
    } finally {
      setSummarizing(false);
    }
  }

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    appShellRef.current = document.querySelector<HTMLElement>(".stacks-shell");
    appShellWasInertRef.current = appShellRef.current?.inert ?? false;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      if (appShellRef.current) appShellRef.current.inert = appShellWasInertRef.current;
      document.body.style.overflow = oldOverflow;
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, []);

  useEffect(() => {
    if (appShellRef.current) appShellRef.current.inert = !suspendAutoClose;
    if (detailPanelRef.current) detailPanelRef.current.inert = suspendAutoClose;
    if (!suspendAutoClose) {
      const frame = requestAnimationFrame(() => detailPanelRef.current?.focus({ preventScroll: true }));
      return () => cancelAnimationFrame(frame);
    }
  }, [suspendAutoClose]);

  // Single-key shortcuts for the modal actions, matching the badges on each
  // button: R Read, S Source, F Feed, E Edit, X Export. Ignored while a modal is
  // open (suspendAutoClose) or while typing in a field, and never with modifiers.
  useEffect(() => {
    if (suspendAutoClose) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        const focusable = [...(detailPanelRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
        ) ?? [])].filter((element) => element.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      // Enter opens the reader (the primary action); letters map to the rest.
      if (event.key === "Enter") { if (hasViewer) { event.preventDefault(); onRead(); } return; }
      switch (event.key.toLowerCase()) {
        case "s": if (paper.url) { event.preventDefault(); window.open(paper.url, "_blank", "noreferrer"); } break;
        case "f": event.preventDefault(); onChat(); break;
        case "e": event.preventDefault(); onEdit(); break;
        case "x": event.preventDefault(); onExport(); break;
        default: break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [suspendAutoClose, hasViewer, paper.url, onClose, onRead, onChat, onEdit, onExport]);

  const dialog = (
    <div className="drawer-layer">
      <Scrim onClick={onClose} label="Close paper details" />
      <section
        ref={detailPanelRef}
        className="detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={detailTitleId}
        tabIndex={-1}
      >
        <div className="drawer-fixed-head">
          <div className="detail-actions-top">
            <button className={`star-button star-button-large ${paper.favorite ? "is-starred" : ""}`} onClick={() => void onUpdate(paper, { favorite: !paper.favorite }, paper.favorite ? "Removed from starred papers." : "Paper starred.")} aria-label={paper.favorite ? "Remove from starred papers" : "Star this paper"}>
              <Star size={16} fill={paper.favorite ? "currentColor" : "none"} />
            </button>
            <ActionButton variant="ghost" size="icon" onClick={onClose} aria-label="Close" icon={<X />} />
          </div>
          <h2 id={detailTitleId}>{paper.title}</h2>
          <div className="detail-authors" aria-label="Paper authors">
            <AdaptiveAuthors authors={paper.authors} onOpenAuthor={onOpenAuthor} showAll />
          </div>
          <div className="paper-detail-toolbar" aria-label="Paper actions">
            {hasViewer ? <ActionButton variant="primary" onClick={onRead} icon={<BookOpen />} kbd="↵">Read</ActionButton> : null}
            {paper.url ? <ActionLink variant="secondary" href={paper.url} target="_blank" rel="noreferrer" icon={<ExternalLink />} kbd="S">Source</ActionLink> : null}
            <ActionButton variant="brand-ghost" onClick={onChat} icon={<Sparkles />} kbd="F">Feed</ActionButton>
            <ActionButton variant="secondary" onClick={onEdit} icon={<Pencil />} kbd="E">Edit</ActionButton>
            <ActionButton variant="secondary" onClick={onExport} icon={<Download />} kbd="X">Export</ActionButton>
          </div>
        </div>
        <div className="drawer-content">
          <aside className="paper-detail-record" aria-label="Paper record">
            <dl className="paper-facts paper-detail-facts">
              <div className="paper-fact">
                <dt>Venue</dt>
                <dd><TextButton link className="max-w-full truncate text-[var(--ink)]" title={venueFullNameHint(paper)} onClick={onOpenVenue} disabled={!paper.venueId && !paper.venueName && !paper.venueAcronym}>{venueLine(paper)}</TextButton></dd>
              </div>
              <div className="paper-fact">
                <dt>Year</dt>
                <dd>{paper.year ?? "—"}</dd>
              </div>
              <div className="paper-fact">
                <dt>Type</dt>
                <dd className="capitalize">{paper.paperType}</dd>
              </div>
            </dl>
            <section className="paper-detail-record-section">
              <span className="paper-field-label">Reading status</span>
              <div className="reading-status-toggle" role="radiogroup" aria-label="Reading status">
                {["inbox", "reading", "complete"].map((status) => (
                  <button
                    key={status}
                    type="button"
                    role="radio"
                    aria-checked={paper.readingStatus === status}
                    className={`reading-status-option status-${status} ${paper.readingStatus === status ? "is-active" : ""}`}
                    onClick={() => void onUpdate(paper, { readingStatus: status }, `Marked as ${statusLabel(status).toLowerCase()}.`)}
                  >
                    <span className="reading-status-icon" aria-hidden="true"><StatusIcon status={status} /></span>
                    <span className="reading-status-label">{statusLabel(status)}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="paper-detail-record-section">
              <span className="paper-field-label">Collections</span>
              <div className="collection-chips">{paper.collections.length ? paper.collections.map((collection) => <CollectionChip key={collection.id} name={collection.name} color={collection.color} onClick={() => onOpenCollection(collection.id, collection.name)} />) : <span className="row-muted paper-field-empty">No collections yet</span>}</div>
            </section>
            {paper.volume || paper.issue || paper.pages || paper.category || paper.doi || paper.preprintId || paper.semanticScholarId || paper.url || paper.pdfUrl || paper.localPath || paper.htmlSnapshotPath ? (
              <section className="paper-detail-record-section">
                <p className="eyebrow">Publication</p>
                <div className="identifier-list publication-detail-list">
                  {paper.volume ? <span><b>Volume</b>{paper.volume}</span> : null}
                  {paper.issue ? <span><b>Issue</b>{paper.issue}</span> : null}
                  {paper.pages ? <span><b>Pages</b>{paper.pages}</span> : null}
                  {paper.category ? <span><b>Category</b>{paper.category}</span> : null}
                  {paper.doi ? <span><b>DOI</b><a className="publication-link" href={doiHref(paper.doi)} target="_blank" rel="noreferrer" title={doiHref(paper.doi)}>{paper.doi}</a></span> : null}
                  {paper.preprintId ? <span><b>Preprint</b>{paper.preprintId}</span> : null}
                  {paper.semanticScholarId ? <span><b>S2 ID</b>{paper.semanticScholarId}</span> : null}
                  {paper.url ? <span className="publication-file-row"><b>Source</b><a className="publication-link" href={paper.url} target="_blank" rel="noreferrer" title={paper.url}>{paper.url}</a></span> : null}
                  {paper.pdfUrl && paper.pdfUrl !== paper.url ? <span className="publication-file-row"><b>PDF URL</b><a className="publication-link" href={paper.pdfUrl} target="_blank" rel="noreferrer" title={paper.pdfUrl}>{paper.pdfUrl}</a></span> : null}
                  {paper.localPath ? <span className="publication-file-row"><b>File</b><TextButton link className="publication-file-link" onClick={() => void onRevealFile("pdf", paper.localPath!)} title={paper.localFilePath ?? paper.localPath}>{paper.localPath}</TextButton></span> : null}
                  {paper.htmlSnapshotPath ? <span className="publication-file-row"><b>HTML</b><TextButton link className="publication-file-link" onClick={() => void onRevealFile("html", paper.htmlSnapshotPath!)} title={paper.htmlFilePath ?? paper.htmlSnapshotPath}>{paper.htmlSnapshotPath}</TextButton></span> : null}
                </div>
              </section>
            ) : null}
          </aside>
          <div className="paper-detail-reading">
            <div className="paper-detail-tabs-header">
              <div ref={detailTabListRef} className="paper-detail-tabs" role="tablist" aria-label="Paper content">
                {detailTabs.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    id={`${detailTabsId}-${tab}-tab`}
                    className={`paper-detail-tab ${activeDetailTab === tab ? "is-active" : ""}`}
                    role="tab"
                    aria-selected={activeDetailTab === tab}
                    aria-controls={`${detailTabsId}-${tab}-panel`}
                    tabIndex={activeDetailTab === tab ? 0 : -1}
                    onClick={() => setActiveDetailTab(tab)}
                    onKeyDown={handleDetailTabKeyDown}
                  >
                    {tab === "summary" ? <FileText aria-hidden="true" /> : tab === "abstract" ? <AlignLeft aria-hidden="true" /> : <NotebookPen aria-hidden="true" />}
                    <span>{tab === "notes" ? "Notes" : tab[0].toUpperCase() + tab.slice(1)}</span>
                  </button>
                ))}
              </div>
              {activeDetailTab === "summary" ? (
                <button type="button" className="eyebrow-generate" onClick={() => void generateSummary()} disabled={summaryRunning} aria-busy={summaryRunning}>
                  {summaryRunning ? <LoaderCircle className="spin" size={13} /> : <WandSparkles size={13} />}
                  {paper.summary ? "Regenerate" : "Generate"}
                </button>
              ) : null}
            </div>
            <section
              id={`${detailTabsId}-${activeDetailTab}-panel`}
              className={`paper-detail-tab-panel is-${activeDetailTab}`}
              role="tabpanel"
              aria-labelledby={`${detailTabsId}-${activeDetailTab}-tab`}
              tabIndex={0}
            >
              {activeDetailTab === "summary" ? (
                paper.summary ? <MarkdownContent content={paper.summary} className="summary-copy" /> : <p className="summary-empty">No summary yet.</p>
              ) : activeDetailTab === "abstract" ? (
                <MarkdownContent content={paper.abstract || "No abstract is recorded for this paper."} className="abstract-copy" />
              ) : (
                <MarkdownCodeEditor
                  value={notesDraft}
                  onChange={setNotesDraft}
                  onBlur={() => { if (notesDraft !== paper.notes) void onUpdate(paper, { notes: notesDraft }, "Notes saved."); }}
                  rows={14}
                  ariaLabel="Research notes"
                  placeholder="Add an observation, question, or connection…"
                />
              )}
            </section>
          </div>
        </div>
        <div className="drawer-footer"><span>Added {formatDate(paper.addedAt)}</span><TextButton tone="danger" onClick={onDelete} icon={<Trash2 />}>Delete paper</TextButton></div>
      </section>
    </div>
  );

  return createPortal(dialog, document.body);
}

function ModalFrame({ title, subtitle, onClose, children, className = "" }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  if (typeof document === "undefined") return null;
  return createPortal((
    <div className="modal-layer">
      <Scrim onClick={onClose} label="Close dialog" />
      <section className={`modal-card ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header"><div><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div><ActionButton variant="ghost" size="icon" onClick={onClose} aria-label="Close" icon={<X />} /></div>
        {children}
      </section>
    </div>
  ), document.body);
}

function ExportReferencesModal({ papers, onClose }: {
  papers: Paper[];
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ReferenceExportFormat>("bibtex");
  const [copied, setCopied] = useState(false);
  const preview = useMemo(() => exportReferences(papers, format), [papers, format]);
  const formatMetadata = referenceExportFormats.find((candidate) => candidate.id === format) ?? referenceExportFormats[0];

  async function copyPreview() {
    try {
      await navigator.clipboard.writeText(preview);
    } catch {
      const field = document.createElement("textarea");
      field.value = preview;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <ModalFrame
      title="Export references"
      subtitle={`${papers.length} selected ${papers.length === 1 ? "paper" : "papers"}. `}
      onClose={onClose}
      className="export-modal"
    >
      <div className="export-modal-body">
        <div className="export-format-tabs" role="tablist" aria-label="Reference format">
          {referenceExportFormats.map((candidate) => (
            <TabButton
              variant="pill"
              role="tab"
              aria-selected={format === candidate.id}
              active={format === candidate.id}
              key={candidate.id}
              onClick={() => setFormat(candidate.id)}
            >
              {candidate.label}
            </TabButton>
          ))}
        </div>
        <section className="export-preview-panel" aria-label={`${formatMetadata.label} export preview`}>
          <header><strong>Preview</strong><span>{formatMetadata.label}</span></header>
          <pre className={`export-preview export-preview-${format}`}><code><ExportSyntaxPreview value={preview} format={format} /></code></pre>
        </section>
      </div>
      <div className="export-modal-actions">
        <ActionButton variant="secondary" icon={copied ? <Check size={17} /> : <Clipboard size={17} />} onClick={() => void copyPreview()} disabled={!preview}>{copied ? "Copied" : "Copy"}</ActionButton>
        <ActionButton variant="primary" icon={<Download size={17} />} onClick={() => downloadReferences(papers, format)} disabled={!papers.length}>Download .{formatMetadata.extension}</ActionButton>
      </div>
    </ModalFrame>
  );
}

function ExportSyntaxPreview({ value, format }: {
  value: string;
  format: ReferenceExportFormat;
}) {
  return value.split("\n").map((line, lineIndex) => (
    <span className="export-code-line" key={`${lineIndex}-${line}`}>
      {highlightExportLine(line, format)}
    </span>
  ));
}

function highlightExportLine(line: string, format: ReferenceExportFormat): ReactNode[] {
  const patterns: Record<ReferenceExportFormat, RegExp> = {
    bibtex: /(@[A-Za-z]+)|(^\s*[A-Za-z][\w-]*(?=\s*=))|(\{[^{}\n]*\})|(\b\d{4}\b)/g,
    ieee: /(^\[\d+\])|(“[^”]+”)|(doi:\s*\S+)|(\b(?:19|20)\d{2}\b)/gi,
    markdown: /(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))|(\*[^*]+\*)|(^-\s+)/g,
    html: /(<\/?[A-Za-z][^>]*>)|(&[A-Za-z#0-9]+;)/g,
    json: /("(?:\\.|[^"\\])*"(?=\s*:))|("(?:\\.|[^"\\])*")|(-?\b\d+(?:\.\d+)?\b)|(\b(?:true|false|null)\b)/g,
  };
  const pattern = patterns[format];
  const highlighted: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > cursor) {
      highlighted.push(line.slice(cursor, match.index));
    }
    const tokenClass = match[1]
      ? "keyword"
      : match[2]
        ? "field"
        : match[3]
          ? "string"
          : "number";
    highlighted.push(
      <span className={`export-token export-token-${tokenClass}`} key={`${tokenIndex}-${match.index}`}>
        {match[0]}
      </span>,
    );
    cursor = pattern.lastIndex;
    tokenIndex += 1;
  }

  if (cursor < line.length) {
    highlighted.push(line.slice(cursor));
  }
  return highlighted.length ? highlighted : [line || "\u00a0"];
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
      const payload = await runTask(`Copy ${file.name} into Stacks storage`, async () => {
        const response = await fetch("/api/local-file-import", {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Stacks-File-Kind": kind,
            "X-Stacks-File-Name": encodeURIComponent(file.name),
          },
          body: file,
        });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
        const stored = await response.json() as { storedPath: string; bytes?: number };
        if (typeof stored.bytes === "number" && stored.bytes !== file.size) {
          throw new Error(`Only ${stored.bytes} of ${file.size} bytes were stored, so the copy was stopped.`);
        }
        return stored;
      });
      if (pathInput.current) {
        pathInput.current.value = payload.storedPath;
      }
      notify(`${file.name} copied into your library.`);
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
        <ActionButton type="button" variant="secondary" size="icon" className="h-auto w-[42px] self-stretch" onClick={() => fileInput.current?.click()} disabled={uploading} aria-label={`Choose local ${kind === "pdf" ? "PDF" : "HTML"} file`} icon={uploading ? <LoaderCircle className="spin" /> : <FolderOpen />} />
        <input
          ref={fileInput}
          className="local-file-picker"
          type="file"
          accept={kind === "pdf" ? ".pdf,application/pdf" : ".html,.htm,text/html"}
          onChange={(event) => void loadLocalFile(event)}
          tabIndex={-1}
        />
      </div>
      
    </label>
  );
}

/**
 * Renders autocomplete options in a body portal, fixed-positioned under the
 * given anchor, so the list escapes the scrollable modal-body's overflow clip
 * (which would otherwise truncate it for fields near the bottom). Re-measures on
 * scroll/resize and while open.
 */
function AnchoredOptions({ anchorRef, open, className, id, children }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  className: string;
  id: string;
  children: ReactNode;
}) {
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const node = anchorRef.current;
      if (!node) return;
      const r = node.getBoundingClientRect();
      // Sit just below the anchor's full height (a wrapped tag-editor can be
      // several rows tall), so the list never overlaps the input.
      setRect({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, anchorRef]);
  if (!open || !rect) return null;
  return createPortal(
    <div className={className} id={id} role="listbox" style={{ position: "fixed", top: rect.top, left: rect.left, width: rect.width }}>
      {children}
    </div>,
    document.body,
  );
}

/**
 * Author names as reorderable chips.
 *
 * Author order is meaningful (it is stored as `author_order` and decides who
 * reads as first author), so the field makes it directly editable: each name is
 * a chip that can be dragged into position, and the order on screen is the order
 * submitted. A hidden input carries the comma-joined value, so the surrounding
 * form contract is unchanged.
 */
type AuthorNamesFieldProps = { authors: Author[] } & (
  | { defaultValue?: string; value?: never; onChange?: never }
  | { defaultValue?: never; value: string[]; onChange: (names: string[]) => void }
);

function AuthorNamesField({
  authors,
  defaultValue = "",
  value,
  onChange,
}: AuthorNamesFieldProps) {
  const listboxId = useId();
  const editorRef = useRef<HTMLDivElement>(null);
  const [uncontrolledNames, setUncontrolledNames] = useState<string[]>(() =>
    defaultValue.split(",").map((name) => name.trim()).filter(Boolean),
  );
  const names = value ?? uncontrolledNames;
  function setNames(update: SetStateAction<string[]>) {
    if (value === undefined) {
      // Pass the updater through to React so batched edits each receive the most
      // recent state instead of the names captured by this render.
      setUncontrolledNames(update);
      return;
    }
    const next = typeof update === "function" ? update(value) : update;
    onChange(next);
  }
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Where the dragged chip would be inserted: the gap before this many chips.
  // Tracked as a gap (0..names.length) rather than a target chip so the caret
  // renders between two names, which is what a drop actually does.
  const [dropGap, setDropGap] = useState<number | null>(null);

  const taken = new Set(names.map((name) => name.toLowerCase()));
  const fragment = query.trim().toLowerCase();
  const matches = fragment
    ? authors
      .filter((author) => author.displayName.toLowerCase().includes(fragment) && !taken.has(author.displayName.toLowerCase()))
      .slice(0, 8)
    : [];

  function addName(name: string) {
    const cleaned = name.trim();
    if (!cleaned || taken.has(cleaned.toLowerCase())) {
      setQuery("");
      return;
    }
    setNames((current) => [...current, cleaned]);
    setQuery("");
    setOpen(false);
  }

  /** Move a chip to a new slot, keeping every other name's relative order. */
  function moveName(from: number, to: number) {
    setNames((current) => moveItem(current, from, to));
  }

  /** Drop the dragged chip into an insertion gap (see app/lib/reorder.ts). */
  function dropIntoGap(gap: number) {
    if (dragIndex === null) return;
    setNames((current) => moveItemToGap(current, dragIndex, gap));
    setDragIndex(null);
    setDropGap(null);
  }

  /** The gap nearest the cursor: before this chip, or after it. */
  function pointerGap(event: ReactDragEvent<HTMLElement>, index: number): number {
    return gapForPointer(event.currentTarget.getBoundingClientRect(), event.clientX, index);
  }

  return (
    <div className="paper-author-field field-span-2">
      <span className="paper-author-label">Authors</span>
      <div
        className="author-tag-editor"
        ref={editorRef}
        // Dropping in the empty space past the last chip moves the name to the
        // end, and leaving the editor clears the caret so it can't linger.
        onDragOver={(event) => {
          if (dragIndex === null) return;
          event.preventDefault();
          if (event.target === event.currentTarget) setDropGap(names.length);
        }}
        onDrop={(event) => {
          if (dragIndex === null) return;
          event.preventDefault();
          dropIntoGap(dropGap ?? names.length);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDropGap(null);
        }}
      >
        {names.map((name, index) => (
          <span
            key={`${name}-${index}`}
            className={cx(
              "author-chip",
              dragIndex === index && "is-dragging",
              // Only the chip adjacent to the target gap draws the caret, and
              // never on the side facing the chip's own original position.
              dropGap === index && dragIndex !== index && "is-drop-before",
              dropGap === index + 1 && dragIndex !== index && index === names.length - 1 && "is-drop-after",
            )}
            draggable
            onDragStart={(event) => {
              setDragIndex(index);
              event.dataTransfer.effectAllowed = "move";
              // Firefox needs some payload set for a drag to start at all.
              event.dataTransfer.setData("text/plain", name);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              // Same reason as onDrop: the editor's handler would otherwise
              // overwrite this gap with "past the last chip".
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
              if (dragIndex !== null) setDropGap(pointerGap(event, index));
            }}
            onDrop={(event) => {
              event.preventDefault();
              // Must not bubble: the editor also handles drop (for the empty
              // space past the last chip), and because setDragIndex(null) here
              // doesn't apply until the next render, that handler would still
              // see the old dragIndex and move the name a second time.
              event.stopPropagation();
              dropIntoGap(pointerGap(event, index));
            }}
            onDragEnd={() => { setDragIndex(null); setDropGap(null); }}
            title={`${name} (drag to reorder)`}
          >
            <GripVertical size={12} className="author-chip-grip" aria-hidden="true" />
            <span className="author-chip-name">{name}</span>
            {/* Keyboard path for reordering, so it isn't drag-only. */}
            <button
              type="button"
              className="author-chip-move"
              onClick={() => moveName(index, index - 1)}
              disabled={index === 0}
              aria-label={`Move ${name} earlier`}
              title="Move earlier"
            ><ChevronUp size={11} /></button>
            <button
              type="button"
              className="author-chip-move"
              onClick={() => moveName(index, index + 1)}
              disabled={index === names.length - 1}
              aria-label={`Move ${name} later`}
              title="Move later"
            ><ChevronDown size={11} /></button>
            <button
              type="button"
              className="author-chip-remove"
              onClick={() => setNames((current) => current.filter((_, position) => position !== index))}
              aria-label={`Remove ${name}`}
            ><X size={11} /></button>
          </span>
        ))}
        <input
          value={query}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => { addName(query); setOpen(false); }, 120)}
          onKeyDown={(event) => {
            // Comma keeps working for people pasting a comma-separated list.
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addName(query);
            }
            if (event.key === "Backspace" && !query && names.length) {
              setNames((current) => current.slice(0, -1));
            }
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (!pasted.includes(",")) return;
            event.preventDefault();
            const incoming = pasted.split(",").map((name) => name.trim()).filter(Boolean);
            setNames((current) => {
              const seen = new Set(current.map((name) => name.toLowerCase()));
              return [...current, ...incoming.filter((name) => !seen.has(name.toLowerCase()) && seen.add(name.toLowerCase()))];
            });
            setQuery("");
          }}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && Boolean(matches.length)}
          aria-controls={listboxId}
          autoComplete="off"
          placeholder={names.length ? "Add another author…" : "Amina Rahman"}
        />
      </div>
      {/* The submitted value: first author first, in the order shown. */}
      <input type="hidden" name="authors" value={names.join(", ")} />
      <AnchoredOptions anchorRef={editorRef} open={open && Boolean(matches.length)} className="metadata-autocomplete-options" id={listboxId}>
        {matches.map((author) => (
          <button type="button" role="option" aria-selected="false" onMouseDown={(event) => event.preventDefault()} onClick={() => addName(author.displayName)} key={author.id}>
            <UsersRound size={14} />
            <span><strong>{author.displayName}</strong><small>{author.paperCount} {author.paperCount === 1 ? "paper" : "papers"}</small></span>
          </button>
        ))}
      </AnchoredOptions>
      <small>Drag to reorder; the first name is the first author.</small>
    </div>
  );
}

function VenueFields({ venues, label, defaultName = "", defaultAcronym = "", placeholder, showAcronym, span = true }: { venues: Venue[]; label: string; defaultName?: string; defaultAcronym?: string; placeholder: string; showAcronym: boolean; span?: boolean }) {
  const listboxId = useId();
  const nameFieldRef = useRef<HTMLLabelElement>(null);
  const acronymFieldRef = useRef<HTMLLabelElement>(null);
  const [name, setName] = useState(defaultName);
  const [acronym, setAcronym] = useState(defaultAcronym);
  const [open, setOpen] = useState(false);
  const [activeField, setActiveField] = useState<"name" | "acronym">("name");
  const activeFieldRef = activeField === "acronym" ? acronymFieldRef : nameFieldRef;
  const query = (activeField === "name" ? name : acronym).trim().toLowerCase();
  const matches = query ? venues.filter((venue) => `${venue.name} ${venue.acronym ?? ""}`.toLowerCase().includes(query)).slice(0, 8) : [];
  function choose(venue: Venue) {
    setName(venue.name);
    setAcronym(venue.acronym ?? "");
    setOpen(false);
  }
  return (
    <div className={`venue-field-pair ${span ? "field-span-2" : ""} ${showAcronym ? "has-acronym" : ""}`}>
      <label ref={nameFieldRef} className="autocomplete-field">
        <span>{label}</span>
        <input name="venueName" value={name} onChange={(event) => { setName(event.target.value); setActiveField("name"); if (event.nativeEvent.isTrusted) setOpen(true); }} onFocus={() => { setActiveField("name"); setOpen(true); }} onBlur={() => window.setTimeout(() => setOpen(false), 120)} role="combobox" aria-autocomplete="list" aria-expanded={open && activeField === "name" && Boolean(matches.length)} aria-controls={listboxId} autoComplete="off" placeholder={placeholder} />
      </label>
      {showAcronym ? (
        <label ref={acronymFieldRef} className="autocomplete-field">
          <span>Venue acronym</span>
          <input name="venueAcronym" value={acronym} onChange={(event) => { setAcronym(event.target.value); setActiveField("acronym"); if (event.nativeEvent.isTrusted) setOpen(true); }} onFocus={() => { setActiveField("acronym"); setOpen(true); }} onBlur={() => window.setTimeout(() => setOpen(false), 120)} role="combobox" aria-autocomplete="list" aria-expanded={open && activeField === "acronym" && Boolean(matches.length)} aria-controls={listboxId} autoComplete="off" spellCheck={false} placeholder="NeurIPS" />
        </label>
      ) : null}
      <AnchoredOptions anchorRef={activeFieldRef} open={open && Boolean(matches.length)} className="metadata-autocomplete-options venue-autocomplete-options" id={listboxId}>{matches.map((venue) => <button type="button" role="option" aria-selected="false" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(venue)} key={venue.id}><Building2 size={14} /><span><strong>{venue.name}</strong><small>{venue.acronym || venue.type}</small></span></button>)}</AnchoredOptions>
    </div>
  );
}

function CollectionNamesField({ collections, value, onChange }: { collections: Collection[]; value: string[]; onChange: (value: string[]) => void }) {
  const listboxId = useId();
  const editorRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selectedNames = new Set(value.map((name) => name.toLowerCase()));
  const matches = query.trim() ? collections
    .filter((collection) => collection.name.toLowerCase().includes(query.trim().toLowerCase()) && !selectedNames.has(collection.name.toLowerCase()))
    .slice(0, 8) : [];
  // Look up each selected name's color so the chips match the paper list. A
  // brand-new name (not yet a collection) falls back to the default blue.
  const colorByName = new Map(collections.map((collection) => [collection.name.toLowerCase(), collection.color]));
  const colorFor = (name: string) => colorByName.get(name.toLowerCase()) ?? DEFAULT_COLLECTION_COLOR;

  function addName(name: string) {
    const cleaned = name.trim();
    if (!cleaned || selectedNames.has(cleaned.toLowerCase())) {
      setQuery("");
      return;
    }
    onChange([...value, cleaned]);
    setQuery("");
    setOpen(false);
  }

  return (
    <div className="paper-collection-field field-span-2">
      <span className="paper-collection-label">Collections</span>
      <div className="collection-tag-editor" ref={editorRef}>
        {value.map((name) => (
          <CollectionChip key={name} name={name} color={colorFor(name)} onRemove={() => onChange(value.filter((candidate) => candidate !== name))} />
        ))}
        <input
          value={query}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => { addName(query); setOpen(false); }, 120)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addName(query);
            }
            if (event.key === "Backspace" && !query && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && Boolean(matches.length)}
          aria-controls={listboxId}
          placeholder={value.length ? "Add another…" : "Add or create a collection…"}
        />
      </div>
      <AnchoredOptions anchorRef={editorRef} open={open && Boolean(matches.length)} className="metadata-autocomplete-options collection-autocomplete-options" id={listboxId}>
        {matches.map((collection) => <button type="button" role="option" aria-selected="false" onMouseDown={(event) => event.preventDefault()} onClick={() => addName(collection.name)} key={collection.id}><span className={`collection-option-dot swatch-${collection.color}`} /><span><strong>{collection.name}</strong><small>{collection.paperCount} {collection.paperCount === 1 ? "paper" : "papers"}</small></span></button>)}
      </AnchoredOptions>
      <small>Choose an existing collection or type a new name and press Enter.</small>
    </div>
  );
}

function PaperMetadataFields({ paperType, paper, venues, notify }: {
  paperType: EditablePaperType;
  paper?: Paper;
  venues: Venue[];
  notify: (message: string, tone?: ToastState["tone"]) => void;
}) {
  const visible = metadataVisibility(paperType);
  const venueLabel = VENUE_LABELS[paperType] ?? "Full venue name";
  const [downloading, setDownloading] = useState(false);
  const { runTask } = useBackgroundTasks();

  async function downloadSource(event: ReactMouseEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    if (!form) {
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries()) as Record<string, unknown>;
    data.paperType = paperType;
    // Only reuse the stored explicit PDF URL when the Source URL is unchanged.
    // If the user edited the Source URL, the old pdfUrl is stale — dropping it
    // lets the server derive a fresh PDF candidate from the new source instead
    // of downloading the previous paper's PDF.
    const editedUrl = paperValue(data, "url");
    data.pdfUrl = editedUrl && editedUrl === (paper?.url ?? "") ? (paper?.pdfUrl ?? "") : "";
    if (!hasAcquirableSource(data)) {
      notify("Enter a Source URL or preprint identifier before downloading.", "error");
      return;
    }
    setDownloading(true);
    try {
      const result = await runTask(`Acquire local source · ${paperValue(data, "title") || "paper"}`, () => acquirePaperSource(data));
      // Both file fields are always rendered, so the path can be written straight
      // in. The paper type is left alone: a paper that happens to have an HTML
      // snapshot is still a paper, and silently rewriting the type discarded a
      // choice the user had just made.
      const field = form.elements.namedItem(result.kind === "pdf" ? "localPath" : "htmlSnapshotPath");
      if (field instanceof HTMLInputElement) {
        field.value = result.storedPath;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
      notify(`${result.kind === "pdf" ? "PDF" : "HTML snapshot"} downloaded into Stacks storage.`, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The source could not be downloaded.", "error");
    } finally {
      setDownloading(false);
    }
  }
  return (
    <>
      {visible.venueName ? <VenueFields venues={venues} label={venueLabel} defaultName={paper?.venueName ?? ""} defaultAcronym={paper?.venueAcronym ?? ""} placeholder={paperType === "preprint" ? "arXiv" : "Neural Information Processing Systems"} showAcronym={visible.venueAcronym} span={paperType !== "preprint"} /> : null}
      {visible.volumeIssue ? <label><span>Volume</span><input name="volume" defaultValue={paper?.volume ?? ""} placeholder="42" /></label> : null}
      {visible.volumeIssue ? <label><span>Issue</span><input name="issue" defaultValue={paper?.issue ?? ""} placeholder="3" /></label> : null}
      {visible.pages ? <label><span>Pages</span><input name="pages" defaultValue={paper?.pages ?? ""} placeholder="101-118" /></label> : null}
      {visible.preprint ? <label><span>Category</span><input name="category" defaultValue={paper?.category ?? ""} placeholder="cs.CL" /></label> : null}
      {visible.preprint ? <label><span>Preprint ID</span><input name="preprintId" defaultValue={paper?.preprintId ?? ""} placeholder="arXiv:2607.01234" /></label> : null}
      {visible.doi ? <label><span>DOI</span><input name="doi" defaultValue={paper?.doi ?? ""} placeholder="10.1000/xyz123" /></label> : null}
      {visible.url ? <label className="field-span-2 source-url-field"><span>Source URL</span><div className="source-url-control"><input name="url" type="url" defaultValue={paper?.url ?? ""} placeholder="https://…" /><ActionButton variant="secondary" size="icon" className="h-auto min-w-[44px] self-stretch" onClick={(event) => void downloadSource(event)} disabled={downloading} title="Download PDF or save an HTML snapshot" aria-label={downloading ? "Downloading source" : "Download PDF or save an HTML snapshot"} icon={downloading ? <LoaderCircle className="spin" /> : <Download />} /></div></label> : null}
      {/* Always both: a record can hold a PDF and an HTML snapshot at once, and
          either must stay manageable whatever the type says. */}
      <LocalFileField name="localPath" label="Local PDF path" kind="pdf" defaultValue={paper?.localPath ?? ""} notify={notify} />
      <LocalFileField name="htmlSnapshotPath" label="Local HTML snapshot path" kind="html" defaultValue={paper?.htmlSnapshotPath ?? ""} notify={notify} />
    </>
  );
}

function AddPaperModal({ authors, venues, collections, onClose, mutateLibrary, notify }: {
  authors: Author[];
  venues: Venue[];
  collections: Collection[];
  onClose: () => void;
  mutateLibrary: (body: MutationBody, successMessage: string) => Promise<boolean>;
  notify: (message: string, tone?: ToastState["tone"]) => void;
}) {
  const [tab, setTab] = useState<"search" | "identifier" | "bibliography" | "pdf" | "url" | "manual">("search");
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<DiscoveryProvider>("semantic-scholar");
  const [identifierSource, setIdentifierSource] = useState<IdentifierSource>("arxiv");
  const [identifier, setIdentifier] = useState("");
  const [bibliographyFile, setBibliographyFile] = useState<File | null>(null);
  const [bibDragActive, setBibDragActive] = useState(false);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfDragActive, setPdfDragActive] = useState(false);
  const [results, setResults] = useState<DiscoveryResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const [manualPaperType, setManualPaperType] = useState<EditablePaperType>("conference");
  const [manualAbstract, setManualAbstract] = useState("");
  const [manualSummary, setManualSummary] = useState("");
  const [manualNotes, setManualNotes] = useState("");
  const [manualCollectionNames, setManualCollectionNames] = useState<string[]>([]);
  const { runTask } = useBackgroundTasks();

  function acceptDroppedPdf(file: File | undefined) {
    if (!file) {
      return;
    }
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      notify("Drop a .pdf file to import.", "error");
      return;
    }
    setPdfFile(file);
  }

  function acceptDroppedBibliography(file: File | undefined) {
    if (!file) {
      return;
    }
    if (!/\.(bib|bibtex|ris|txt)$/i.test(file.name)) {
      notify("Drop a .bib, .bibtex, .ris, or .txt file to import.", "error");
      return;
    }
    setBibliographyFile(file);
  }

  async function acquireImportSource(data: Record<string, unknown>, log?: TaskLogger): Promise<Record<string, unknown>> {
    if (!hasAcquirableSource(data)) {
      log?.step("No downloadable source on the record, keeping metadata only.");
      return data;
    }
    log?.step("Downloading the source file…");
    try {
      const result = await acquirePaperSource(data);
      log?.step(`Stored ${result.kind === "pdf" ? "PDF" : "HTML snapshot"}: ${result.storedPath}`);
      return withAcquiredSource(data, result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "download failed";
      log?.step(`The file could not be saved: ${reason}`, "warn");
      notify(`The paper was imported, but its file couldn't be saved: ${reason}`, "info");
      return data;
    }
  }

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

  function addResult(result: DiscoveryResult) {
    // Optimistic add; acquire the source and create in the background dock.
    setAdded((current) => [...current, result.sourceId || result.title]);
    void runTask(`Add paper · ${result.title}`, async () => {
      const data = await acquireImportSource({ ...result });
      const succeeded = await mutateLibrary({ entity: "paper", action: "create", data }, "Paper added to your library.");
      if (!succeeded) {
        setAdded((current) => current.filter((id) => id !== (result.sourceId || result.title)));
        throw new Error("The paper could not be added.");
      }
    }).catch(() => {});
  }

  function importUrl(event: FormEvent) {
    event.preventDefault();
    // Fetching a page and snapshotting it is slow enough to outlive the modal, so
    // it goes to the activity dock like the other imports.
    const target = url.trim();
    onClose();
    void runTask("Import web source and acquire content", async (log) => {
      log.step(`Fetching ${target}…`);
      const response = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: target }) });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const result = (await response.json()) as Record<string, unknown>;
      log.step(`Read metadata: ${paperValue(result, "title") || "untitled page"}`);
      const paperData = await acquireImportSource({ ...result, authors: [] }, log);
      log.step("Saving the record to the library…");
      const imported = await mutateLibrary({ entity: "paper", action: "create", data: paperData }, "Page imported and stored locally.");
      if (!imported) {
        throw new Error("The imported source could not be saved.");
      }
      log.step("Saved.");
      return imported;
    }).catch(() => {});
  }

  function importByIdentifier(event: FormEvent) {
    event.preventDefault();
    if (!identifier.trim()) {
      return;
    }
    // Resolving an identifier hits an external service that can take tens of
    // seconds when it throttles, so the modal closes now and the work continues in
    // the activity dock, which reports every stage and any failure.
    const sourceLabel = identifierSources.find((source) => source.id === identifierSource)?.label ?? "Source";
    onClose();
    void runTask(`Resolve and import ${sourceLabel}`, async (log) => {
      log.step(`Resolving ${identifier.trim()} through ${sourceLabel}…`);
      const response = await fetch("/api/import-identifier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: identifierSource, identifier }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await response.json() as { paper: DiscoveryResult };
      log.step(`Resolved: ${payload.paper.title}`);
      const paperData = await acquireImportSource({ ...payload.paper }, log);
      log.step("Saving the record to the library…");
      const imported = await mutateLibrary(
        { entity: "paper", action: "create", data: paperData },
        `${sourceLabel} paper imported.`,
      );
      if (!imported) {
        throw new Error("The resolved paper could not be saved.");
      }
      log.step("Saved.");
      return imported;
    // The dock shows the failure; this keeps it from also becoming an unhandled
    // rejection now that nothing awaits the task.
    }).catch(() => {});
  }

  function importBibliography(event: FormEvent) {
    event.preventDefault();
    if (!bibliographyFile) {
      return;
    }
    const filename = bibliographyFile.name.toLowerCase();
    const format = filename.endsWith(".ris") || filename.endsWith(".txt") ? "ris" : "bibtex";
    // A bibliography can hold hundreds of records, each with its own file download,
    // so this is the longest-running import of all: it belongs in the dock.
    const file = bibliographyFile;
    onClose();
    void runTask(`Import ${file.name}`, async (log) => {
      log.step(`Parsing ${file.name} as ${format === "bibtex" ? "BibTeX" : "RIS"}…`);
      const response = await fetch("/api/import-bibliography", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format, content: await file.text() }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await response.json() as { papers: Array<Record<string, unknown>> };
      log.step(`Parsed ${payload.papers.length} ${payload.papers.length === 1 ? "record" : "records"}.`);
      const papers = await Promise.all(payload.papers.map((paper) => acquireImportSource(paper)));
      log.step("Saving the records to the library…");
      const imported = await mutateLibrary(
        { entity: "paper", action: "bulk-create", data: { papers } },
        `${payload.papers.length} ${format === "bibtex" ? "BibTeX" : "RIS"} ${payload.papers.length === 1 ? "record" : "records"} imported.`,
      );
      if (!imported) {
        throw new Error("The bibliography records could not be saved.");
      }
      log.step("Saved.");
      return imported;
    }).catch(() => {});
  }

  function importLocalPdf(event: FormEvent) {
    event.preventDefault();
    if (!pdfFile) {
      return;
    }
    // Uploading and running metadata extraction over a PDF takes long enough to
    // outlive the modal.
    const file = pdfFile;
    onClose();
    void runTask(`Import and extract ${file.name}`, async (log) => {
      log.step(`Copying ${file.name} into Stacks storage…`);
      const upload = await fetch("/api/local-file-import", {
        method: "POST",
        headers: { "Content-Type": "application/pdf", "X-Stacks-File-Kind": "pdf", "X-Stacks-File-Name": encodeURIComponent(file.name) },
        body: file,
      });
      if (!upload.ok) {
        throw new Error(await readError(upload));
      }
      const { storedPath, bytes } = await upload.json() as { storedPath: string; bytes?: number };
      // The server holds the body to its Content-Length, so this is belt and
      // braces: never tell the user a file was copied when fewer bytes landed.
      if (typeof bytes === "number" && bytes !== file.size) {
        throw new Error(`Only ${bytes} of ${file.size} bytes were stored, so the import was stopped.`);
      }
      log.step(`Stored as ${storedPath} (${bytes ?? file.size} bytes).`);
      log.step("Extracting metadata from the PDF…");
      const extraction = await extractPdfMetadata(file, file.name);
      log.step(`Extracted: ${extraction.metadata.title || "no title found"}`);
      const imported = await mutateLibrary({
        entity: "paper",
        action: "create",
        data: { ...extraction.metadata, localPath: storedPath, readingStatus: "inbox" },
      }, "PDF imported and metadata extracted.");
      if (!imported) {
        throw new Error("The extracted PDF record could not be saved.");
      }
      if (extraction.warning) {
        log.step(extraction.warning, "warn");
        notify(extraction.warning, "info");
      }
      log.step("Saved.");
      return extraction;
    }).catch(() => {});
  }

  async function addManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const visible = metadataVisibility(manualPaperType);
    let data: Record<string, unknown> = {
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
      localPath: form.get("localPath"),
      htmlSnapshotPath: form.get("htmlSnapshotPath"),
      abstract: manualAbstract,
      summary: manualSummary,
      notes: manualNotes,
      collectionNames: manualCollectionNames,
      readingStatus: "inbox",
    };
    const validationError = validatePaperWrite(data);
    if (validationError) {
      notify(validationError, "error");
      return;
    }
    const assetStatus = await checkPaperAssets(data);
    if ((assetStatus.localPath && !assetStatus.pdfExists) || (assetStatus.htmlSnapshotPath && !assetStatus.htmlExists)) {
      notify("That file isn't in your library. Choose another file or clear the path.", "error");
      return;
    }
    data = await runTask(`Store source · ${paperValue(data, "title")}`, () => acquireImportSource(data));
    const succeeded = await mutateLibrary(
      {
        entity: "paper",
        action: "create",
        data,
      },
      "Paper added to your library.",
    );
    if (succeeded) {
      onClose();
    }
  }

  return (
    <ModalFrame title="Add to Stacks" onClose={onClose} className="add-modal">
      <div className="modal-tabs">
        <TabButton variant="underline" active={tab === "search"} onClick={() => setTab("search")} icon={<Search />}>Academic search</TabButton>
        <TabButton variant="underline" active={tab === "identifier"} onClick={() => setTab("identifier")} icon={<Database />}>Identifier</TabButton>
        <TabButton variant="underline" active={tab === "bibliography"} onClick={() => setTab("bibliography")} icon={<Upload />}>BibTeX / RIS</TabButton>
        <TabButton variant="underline" active={tab === "pdf"} onClick={() => setTab("pdf")} icon={<FileSearch />}>Local PDF</TabButton>
        <TabButton variant="underline" active={tab === "url"} onClick={() => setTab("url")} icon={<Link2 />}>URL / PDF link</TabButton>
        <TabButton variant="underline" active={tab === "manual"} onClick={() => setTab("manual")} icon={<Pencil />}>Manual</TabButton>
      </div>
      {tab === "search" ? (
        <div className="modal-body">
          <form className="modal-search-row" onSubmit={searchPapers}>
            <label><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Paper title, DOI, author, or topic" autoFocus /></label>
            <ActionButton type="submit" variant="primary" icon={loading ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />} disabled={loading || !query.trim()}>Search</ActionButton>
          </form>
          <div className="source-row">
            <span>Search in</span>
            {discoveryProviders.map((item) => <TabButton variant="pill" active={provider === item.id} onClick={() => setProvider(item.id)} key={item.id}>{item.label}</TabButton>)}
          </div>
          {!results.length && !loading ? <div className="modal-placeholder"><span><Compass size={22} /></span><h3>Find a paper anywhere.</h3></div> : null}
          <div className="modal-results">
            {results.map((result) => {
              const key = result.sourceId || result.title;
              const isAdded = added.includes(key);
              return <article key={key}><div><small>{result.source} · {result.year ?? "n.d."}</small><h3>{result.title}</h3><p>{result.authors.join(", ") || "Authors unavailable"}</p><span>{result.venueName || "Venue unknown"}</span></div><ActionButton variant={isAdded ? "success" : "primary"} size="small" disabled={isAdded} onClick={() => void addResult(result)} icon={isAdded ? <Check /> : <Plus />}>{isAdded ? "Added" : "Add"}</ActionButton></article>;
            })}
          </div>
        </div>
      ) : tab === "identifier" ? (
        <form className="modal-body identifier-import-form" onSubmit={importByIdentifier}>
          <div className="identifier-source-grid">
            {identifierSources.map((source) => (
              <SelectCard
                key={source.id}
                selected={identifierSource === source.id}
                onClick={() => { setIdentifierSource(source.id); setIdentifier(""); }}
                icon={<Database />}
                title={source.label}
                description={source.hint}
                trailing={identifierSource === source.id ? <Check /> : null}
              />
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
          <ActionButton type="submit" variant="primary" className="full-action" icon={<ArrowRight size={16} />} disabled={!identifier.trim()}>Import paper</ActionButton>
          <p className="identifier-footnote">This imports a single paper. Use BibTeX / RIS to import many at once.</p>
        </form>
      ) : tab === "bibliography" ? (
        <form className="modal-body bibliography-import-form" onSubmit={importBibliography}>
          <label
            className={`bibliography-dropzone ${bibliographyFile ? "has-file" : ""} ${bibDragActive ? "is-dragging" : ""}`}
            onDragOver={(event) => { event.preventDefault(); setBibDragActive(true); }}
            onDragLeave={(event) => { event.preventDefault(); setBibDragActive(false); }}
            onDrop={(event) => { event.preventDefault(); setBibDragActive(false); acceptDroppedBibliography(event.dataTransfer.files?.[0]); }}
          >
            <span className="bibliography-upload-icon">{bibliographyFile ? <Check size={23} /> : <Upload size={23} />}</span>
            <span><strong>{bibliographyFile?.name ?? "Choose or drop a BibTeX or RIS file"}</strong><small>{bibliographyFile ? `${Math.max(1, Math.round(bibliographyFile.size / 1024))} KB · ready to import` : ".bib, .bibtex, .ris, or RIS-formatted .txt · up to 5 MB"}</small></span>
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
          <ActionButton type="submit" variant="primary" className="full-action" icon={<Upload size={16} />} disabled={!bibliographyFile}>Import bibliography</ActionButton>
          
        </form>
      ) : tab === "pdf" ? (
        <form className="modal-body bibliography-import-form" onSubmit={importLocalPdf}>
          <label
            className={`bibliography-dropzone ${pdfFile ? "has-file" : ""} ${pdfDragActive ? "is-dragging" : ""}`}
            onDragOver={(event) => { event.preventDefault(); setPdfDragActive(true); }}
            onDragLeave={(event) => { event.preventDefault(); setPdfDragActive(false); }}
            onDrop={(event) => { event.preventDefault(); setPdfDragActive(false); acceptDroppedPdf(event.dataTransfer.files?.[0]); }}
          >
            <span className="bibliography-upload-icon">{pdfFile ? <Check size={23} /> : <FileSearch size={23} />}</span>
            <span><strong>{pdfFile?.name ?? "Choose or drop a local PDF"}</strong><small>{pdfFile ? `${Math.max(1, Math.round(pdfFile.size / 1024))} KB · ready to extract` : ""}</small></span>
            <input type="file" accept=".pdf,application/pdf" onChange={(event: ChangeEvent<HTMLInputElement>) => setPdfFile(event.target.files?.[0] ?? null)} />
          </label>
          <ActionButton type="submit" variant="primary" className="full-action" icon={<FileSearch size={16} />} disabled={!pdfFile}>Import and extract PDF</ActionButton>
          <p className="identifier-footnote">You can edit the details after import.</p>
        </form>
      ) : tab === "url" ? (
        <form className="modal-body import-form" onSubmit={importUrl}>
          <div className="import-illustration"><Upload size={28} /><span /></div>
          <h3>Import from the web</h3>
          <p>Paste a link to an article, arXiv or publisher page, or PDF.</p>
          <label className="large-field"><Link2 size={17} /><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://arxiv.org/abs/…" required autoFocus /></label>
          <ActionButton type="submit" variant="primary" className="full-action" icon={<WandSparkles size={16} />} disabled={!url.trim()}>Read and import</ActionButton>
        </form>
      ) : (
        <form className="modal-body entity-form" autoComplete="off" onSubmit={addManual}>
          <label className="field-span-2"><span>Paper title *</span><input name="title" required autoFocus placeholder="A precise, complete title" /></label>
          <AuthorNamesField authors={authors} />
          <label><span>Year</span><input name="year" type="number" min="1500" max="2200" defaultValue={new Date().getFullYear()} /></label>
          <label><span>Paper type</span><Select ariaLabel="Paper type" value={manualPaperType} onChange={(next) => setManualPaperType(next as EditablePaperType)} options={paperTypeOptions.map((option) => ({ value: option.value, label: option.label }))} /></label>
          <PaperMetadataFields paperType={manualPaperType} venues={venues} notify={notify} />
          <CollectionNamesField collections={collections} value={manualCollectionNames} onChange={setManualCollectionNames} />
          <label className="field-span-2"><span>Summary</span><MarkdownCodeEditor name="summary" ariaLabel="Summary" rows={4} value={manualSummary} onChange={setManualSummary} placeholder="A short summary for your library…" /></label>
          <label className="field-span-2"><span>Abstract</span><MarkdownCodeEditor name="abstract" ariaLabel="Abstract" rows={5} value={manualAbstract} onChange={setManualAbstract} placeholder="What this paper contributes…" /></label>
          <label className="field-span-2"><span>Research notes</span><MarkdownCodeEditor name="notes" ariaLabel="Research notes" rows={3} value={manualNotes} onChange={setManualNotes} placeholder="Observations, questions, and connections…" /></label>
          <div className="form-actions field-span-2"><ActionButton variant="secondary" icon={<X size={17} />} onClick={onClose}>Cancel</ActionButton><ActionButton type="submit" variant="primary" icon={<Plus size={17} />}>Add paper</ActionButton></div>
        </form>
      )}
    </ModalFrame>
  );
}

function PaperEditModal({ paper, authors, venues, collections, onClose, mutateLibrary, notify }: {
  paper: Paper;
  authors: Author[];
  venues: Venue[];
  collections: Collection[];
  onClose: () => void;
  mutateLibrary: (body: MutationBody, successMessage: string) => Promise<boolean>;
  notify: (message: string, tone?: ToastState["tone"]) => void;
}) {
  const [paperType, setPaperType] = useState<EditablePaperType>(() => editablePaperType(paper.paperType));
  const [summary, setSummary] = useState(paper.summary);
  const [abstract, setAbstract] = useState(paper.abstract);
  const [notes, setNotes] = useState(paper.notes);
  const [summarizing, setSummarizing] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingSave, setPendingSave] = useState<Record<string, unknown> | null>(null);
  const [pendingMetadataReview, setPendingMetadataReview] = useState<PendingMetadataReview | null>(null);
  const [selectedExtractedFields, setSelectedExtractedFields] = useState<Set<ExtractedMetadataField>>(new Set());
  const [authorNames, setAuthorNames] = useState<string[]>(() => paper.authors.map((author) => author.displayName));
  const [collectionNames, setCollectionNames] = useState<string[]>(() => paper.collections.map((collection) => collection.name));
  const formRef = useRef<HTMLFormElement | null>(null);
  const extractionReturnFocusRef = useRef<HTMLElement | null>(null);
  const { runTask, tasks } = useBackgroundTasks();
  const summaryTaskKey = `summary:${paper.id}`;
  const summaryRunning = summarizing || tasks.some((task) => task.key === summaryTaskKey && task.status === "running");
  const metadataReviewPaperType = pendingMetadataReview && selectedExtractedFields.has("paperType")
    ? editablePaperType(pendingMetadataReview.extraction.metadata.paperType)
    : paperType;
  const applicableMetadataReviewFields = new Set(
    pendingMetadataReview?.changes
      .filter((change) => isExtractedMetadataFieldApplicable(change.field, metadataReviewPaperType))
      .map((change) => change.field) ?? [],
  );
  const selectedApplicableMetadataCount = [...selectedExtractedFields]
    .filter((field) => applicableMetadataReviewFields.has(field)).length;
  const firstApplicableMetadataField = pendingMetadataReview?.changes
    .find((change) => applicableMetadataReviewFields.has(change.field))?.field;

  // Restore focus only after React has removed `inert` from the editor form.
  // Trying to focus synchronously while closing the review leaves focus on the
  // document body because the extraction button is still inside an inert tree.
  useEffect(() => {
    if (pendingMetadataReview || !extractionReturnFocusRef.current) return;
    const target = extractionReturnFocusRef.current;
    const frame = window.requestAnimationFrame(() => {
      target.focus();
      if (document.activeElement === target) extractionReturnFocusRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingMetadataReview]);

  async function generateSummary() {
    if (summaryRunning) return;
    setSummarizing(true);
    try {
      const payload = await runTask(`Generate summary · ${paper.title}`, async (log) => {
        return withSummarySlot(async () => {
          log.step("Generating the summary.");
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
                localPath: paper.localPath,
              },
            }),
          });
          if (!response.ok) {
            throw new Error(await readError(response));
          }
          const generated = await response.json() as { summary: string; grounding?: SummaryGrounding };
          log.step(groundingNote(generated.grounding));
          log.step("Saving the generated summary.");
          await mutateLibrary(
            { entity: "paper", action: "update", id: paper.id, data: { summary: generated.summary } },
            summarySavedMessage(generated.grounding),
          );
          return generated;
        }, () => log.step("Waiting for an available summary slot."));
      }, { key: summaryTaskKey });
      setSummary(payload.summary);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Summary generation failed.", "error");
    } finally {
      setSummarizing(false);
    }
  }

  function applyExtractedMetadata(metadata: ExtractedPdfMetadata, selected: Set<ExtractedMetadataField>) {
    if (selected.has("paperType")) {
      setPaperType(editablePaperType(metadata.paperType));
    }
    if (selected.has("authors")) {
      // AuthorNamesField is a chip editor backed by React state. Updating its
      // hidden form input directly changed neither the visible chips nor the
      // submitted author list, which is why extraction appeared to lose authors.
      setAuthorNames(metadata.authors);
    }
    if (selected.has("abstract")) {
      setAbstract(metadata.abstract);
    }

    // A selected paper type can reveal a different set of fields. Wait for that
    // render before filling those inputs so venue/preprint values are not lost.
    window.setTimeout(() => {
      const form = formRef.current;
      if (!form) return;
      const setField = (name: string, value: string | number | null | undefined) => {
        const field = form.elements.namedItem(name);
        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
          const next = value === null || value === undefined ? "" : String(value);
          // These inputs are React-controlled. Use the native setter so React's
          // change tracker sees the dispatched input event as a real update.
          const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          if (nativeSetter) nativeSetter.call(field, next);
          else field.value = next;
          field.dispatchEvent(new Event("input", { bubbles: true }));
          field.dispatchEvent(new Event("change", { bubbles: true }));
        }
      };
      const values: Partial<Record<ExtractedMetadataField, string | number | null>> = {
        title: metadata.title,
        year: metadata.year,
        venueName: metadata.venueName,
        venueAcronym: metadata.venueAcronym,
        preprintId: metadata.preprintId,
        doi: metadata.doi,
        url: metadata.url,
      };
      for (const [field, value] of Object.entries(values)) {
        if (selected.has(field as ExtractedMetadataField)) setField(field, value);
      }
    }, 0);
  }

  function closeMetadataReview() {
    setPendingMetadataReview(null);
  }

  function reviewKeyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMetadataReview();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function applySelectedMetadata() {
    if (!pendingMetadataReview) return;
    const applicableSelectedFields = new Set(
      [...selectedExtractedFields].filter((field) => applicableMetadataReviewFields.has(field)),
    );
    applyExtractedMetadata(pendingMetadataReview.extraction.metadata, applicableSelectedFields);
    const selectedCount = applicableSelectedFields.size;
    const total = applicableMetadataReviewFields.size;
    const warning = pendingMetadataReview.extraction.warning;
    setPendingMetadataReview(null);
    notify(
      warning ?? `${selectedCount} of ${total} extracted ${total === 1 ? "change" : "changes"} applied. Review the form, then save the paper.`,
      warning ? "info" : "success",
    );
  }

  async function extractFromStoredPdf() {
    const form = formRef.current;
    if (!form) {
      return;
    }
    const path = String(new FormData(form).get("localPath") ?? "").trim();
    if (!path) {
      notify("Choose or enter a local PDF path before extracting metadata.", "error");
      return;
    }
    extractionReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setExtracting(true);
    try {
      const payload = await runTask(`Extract PDF metadata · ${paper.title}`, async () => {
        const fileResponse = await fetch(`/stacks-files/pdfs/${encodeURIComponent(path)}`);
        if (!fileResponse.ok) {
          throw new Error("The stored PDF could not be opened.");
        }
        return extractPdfMetadata(await fileResponse.blob(), path);
      });
      const currentForm = new FormData(form);
      const currentValues: Record<ExtractedMetadataField, string> = {
        title: String(currentForm.get("title") ?? ""),
        authors: authorNames.join(", "),
        year: String(currentForm.get("year") ?? ""),
        paperType,
        venueName: String(currentForm.get("venueName") ?? ""),
        venueAcronym: String(currentForm.get("venueAcronym") ?? ""),
        preprintId: String(currentForm.get("preprintId") ?? ""),
        doi: String(currentForm.get("doi") ?? ""),
        url: String(currentForm.get("url") ?? ""),
        abstract,
      };
      const changes = extractedMetadataFields.flatMap(({ field, label }) => {
        const current = currentValues[field];
        const extracted = extractedMetadataValue(payload.metadata, field);
        return comparableMetadataValue(current) === comparableMetadataValue(extracted)
          ? []
          : [{ field, label, current, extracted }];
      });
      if (!changes.length) {
        notify(payload.warning ?? `The extracted metadata matches the current paper details.`, payload.warning ? "info" : "success");
        return;
      }
      const selectsExtractedPaperType = changes.some(
        (change) => change.field === "paperType" && change.extracted.trim(),
      );
      const initialReviewPaperType = selectsExtractedPaperType
        ? editablePaperType(payload.metadata.paperType)
        : paperType;
      setSelectedExtractedFields(new Set(
        changes
          .filter((change) => change.extracted.trim())
          .filter((change) => isExtractedMetadataFieldApplicable(change.field, initialReviewPaperType))
          .map((change) => change.field),
      ));
      setPendingMetadataReview({ extraction: payload, changes });
    } catch (error) {
      notify(error instanceof Error ? error.message : "PDF metadata extraction failed.", "error");
    } finally {
      setExtracting(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const form = new FormData(event.currentTarget);
    // Same rule as the render, so the payload covers exactly the fields the user
    // could see: reading a field the form never rendered would submit it as empty
    // and wipe the stored value.
    const visible = metadataVisibility(paperType);
    const data: Record<string, unknown> = {
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
      ...(visible.url ? { url: form.get("url"), pdfUrl: paper.pdfUrl } : {}),
      localPath: form.get("localPath"),
      htmlSnapshotPath: form.get("htmlSnapshotPath"),
      abstract: form.get("abstract"),
      summary,
      notes: form.get("notes"),
      collectionNames,
    };
    const validationError = validatePaperWrite(data);
    if (validationError) {
      notify(validationError, "error");
      return;
    }
    // Enter the modal's own busy state before the asset check. Summary tasks use
    // their own per-paper keys and cannot disable this save; this flag only
    // prevents a second submit of the edit currently being saved.
    setSaving(true);
    try {
      const assets = await checkPaperAssets(data);
      const missingNamedPdf = Boolean(assets.localPath) && !assets.pdfExists;
      const missingNamedHtml = Boolean(assets.htmlSnapshotPath) && !assets.htmlExists;
      const hasStoredSource = assets.pdfExists || assets.htmlExists;
      if (missingNamedPdf || missingNamedHtml || (!hasStoredSource && hasAcquirableSource(data))) {
        setPendingSave(data);
        setSaving(false);
        return;
      }
      await savePaper(data);
    } catch (error) {
      setSaving(false);
      notify(error instanceof Error ? error.message : "The local source could not be validated.", "error");
    }
  }

  async function savePaper(data: Record<string, unknown>) {
    setSaving(true);
    const succeeded = await mutateLibrary(
      {
        entity: "paper",
        action: "update",
        id: paper.id,
        data,
      },
      "Paper metadata updated across the library.",
    );
    setSaving(false);
    if (succeeded) {
      setPendingSave(null);
      onClose();
    }
  }

  async function acquireThenSave(preferred: "pdf" | "html") {
    if (!pendingSave) {
      return;
    }
    setSaving(true);
    try {
      const result = await runTask(`Store ${preferred.toUpperCase()} · ${paperValue(pendingSave, "title")}`, () => acquirePaperSource(pendingSave, preferred));
      await savePaper(withAcquiredSource({ ...pendingSave, localPath: preferred === "pdf" ? "" : paperValue(pendingSave, "localPath"), htmlSnapshotPath: preferred === "html" ? "" : paperValue(pendingSave, "htmlSnapshotPath") }, result));
    } catch (error) {
      setSaving(false);
      notify(error instanceof Error ? error.message : "The source could not be stored locally.", "error");
    }
  }

  async function saveWithoutLocalCopy() {
    if (!pendingSave) {
      return;
    }
    await savePaper({ ...pendingSave, localPath: "", htmlSnapshotPath: "" });
  }

  return (
    <ModalFrame title="Edit paper" onClose={onClose} className="add-modal edit-paper-modal">
      <form ref={formRef} className="edit-paper-modal-form" autoComplete="off" onSubmit={submit} inert={pendingMetadataReview ? true : undefined}>
        <div className="modal-body entity-form edit-paper-fields">
        <label className="field-span-2"><span>Paper title *</span><input name="title" required defaultValue={paper.title} autoFocus /></label>
        <label><span>Year</span><input name="year" type="number" min="1500" max="2200" defaultValue={paper.year ?? ""} /></label>
        <label><span>Paper type</span><Select ariaLabel="Paper type" value={paperType} onChange={(next) => setPaperType(next as EditablePaperType)} options={paperTypeOptions.map((option) => ({ value: option.value, label: option.label }))} /></label>
        <AuthorNamesField authors={authors} value={authorNames} onChange={setAuthorNames} />
        <PaperMetadataFields paperType={paperType} paper={paper} venues={venues} notify={notify} />
        <CollectionNamesField collections={collections} value={collectionNames} onChange={setCollectionNames} />
        <label className="field-span-2 summary-field"><span className="field-label-action"><span>Summary</span><button type="button" onClick={() => void generateSummary()} disabled={summaryRunning} aria-busy={summaryRunning}>{summaryRunning ? <LoaderCircle className="spin" size={14} /> : <WandSparkles size={14} />}{paper.summary || summary ? "Regenerate" : "Generate"}</button></span><MarkdownCodeEditor name="summary" ariaLabel="Summary" rows={5} value={summary} onChange={setSummary} placeholder="A short summary for your library…" /></label>
        <label className="field-span-2"><span>Abstract</span><MarkdownCodeEditor name="abstract" ariaLabel="Abstract" rows={5} value={abstract} onChange={setAbstract} placeholder="What this paper contributes…" /></label>
        <label className="field-span-2"><span>Research notes</span><MarkdownCodeEditor name="notes" ariaLabel="Research notes" rows={4} value={notes} onChange={setNotes} placeholder="Observations, questions, and connections…" /></label>
        </div>
        <div className="form-actions edit-paper-form-actions">
          <ActionButton
            variant="secondary"
            className="extraction-footer-action"
            onClick={() => void extractFromStoredPdf()}
            disabled={extracting}
            title="Extract metadata from the stored PDF"
            icon={extracting ? <LoaderCircle className="spin" /> : <FileSearch />}
          >
            {extracting ? "Extracting" : "Extract metadata"}
          </ActionButton>
          <span className="form-actions-spacer" />
          <ActionButton variant="secondary" onClick={onClose} icon={<X />}>Cancel</ActionButton>
          <ActionButton type="submit" variant="primary" disabled={saving} icon={saving ? <LoaderCircle className="spin" /> : <Save />}>
            {saving ? "Saving" : "Save paper"}
          </ActionButton>
        </div>
      </form>
      {pendingMetadataReview && typeof document !== "undefined" ? createPortal(
        <div className="metadata-review-layer" role="presentation">
          <Scrim onClick={closeMetadataReview} label="Keep current metadata and close review" />
          <section
            className="metadata-review-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="metadata-review-title"
            aria-describedby="metadata-review-description"
            onKeyDown={reviewKeyboard}
          >
            <header className="metadata-review-heading">
              <span className="asset-acquisition-icon"><FileSearch size={22} /></span>
              <span>
                <h3 id="metadata-review-title">Review extracted metadata</h3>
                <p id="metadata-review-description">
                  Choose which PDF values should replace the current paper details. Nothing changes until you apply your selection.
                </p>
              </span>
            </header>
            {pendingMetadataReview.extraction.warning ? (
              <p className="metadata-review-warning"><CircleAlert size={16} />{pendingMetadataReview.extraction.warning}</p>
            ) : null}
            <div className="metadata-review-list" role="group" aria-label="Extracted metadata changes">
              {pendingMetadataReview.changes.map((change) => {
                const applicable = applicableMetadataReviewFields.has(change.field);
                const selected = applicable && selectedExtractedFields.has(change.field);
                return (
                  <label className={`metadata-review-row ${selected ? "is-selected" : ""} ${applicable ? "" : "is-unavailable"}`} key={change.field}>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={!applicable}
                      autoFocus={change.field === firstApplicableMetadataField}
                      onChange={(event) => {
                        setSelectedExtractedFields((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(change.field);
                          else next.delete(change.field);
                          return next;
                        });
                      }}
                    />
                    <span className="metadata-review-field">
                      {change.label}
                      {!applicable ? <small>Not used by the selected paper type</small> : null}
                    </span>
                    <span className="metadata-review-values">
                      <span><small>Current</small><b>{change.current || "Not recorded"}</b></span>
                      <span><small>Extracted</small><b>{change.extracted || "Not found"}</b></span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="metadata-review-actions">
              <ActionButton variant="secondary" onClick={closeMetadataReview} autoFocus={!firstApplicableMetadataField} icon={<X />}>Keep current values</ActionButton>
              <ActionButton variant="primary" onClick={applySelectedMetadata} disabled={selectedApplicableMetadataCount === 0} icon={<Check />}>
                Apply selected
              </ActionButton>
            </div>
          </section>
        </div>,
        document.body,
      ) : null}
      {pendingSave ? (
        <div className="asset-acquisition-layer" role="presentation">
          <section className="asset-acquisition-dialog" role="alertdialog" aria-modal="true" aria-labelledby="asset-acquisition-title" aria-describedby="asset-acquisition-description">
            <div className="asset-acquisition-icon"><Download size={22} /></div>
            <div>
              <h3 id="asset-acquisition-title">No file saved yet</h3>
              <p id="asset-acquisition-description">The PDF or HTML file isn&apos;t in your library. Save a copy before saving this paper?</p>
            </div>
            <div className="asset-acquisition-actions">
              <ActionButton variant="secondary" onClick={() => setPendingSave(null)} disabled={saving} icon={<X />}>Cancel</ActionButton>
              <ActionButton variant="secondary" onClick={() => void saveWithoutLocalCopy()} disabled={saving} icon={<Save />}>Save without file</ActionButton>
              <ActionButton variant="secondary" onClick={() => void acquireThenSave("html")} disabled={saving || !paperValue(pendingSave, "url")} icon={<FileText />}>Save HTML</ActionButton>
              <ActionButton variant="primary" onClick={() => void acquireThenSave("pdf")} disabled={saving || !hasAcquirableSource(pendingSave)} icon={saving ? <LoaderCircle className="spin" /> : <Download />}>
                Download PDF
              </ActionButton>
            </div>
          </section>
        </div>
      ) : null}
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
  const [collectionColor, setCollectionColor] = useState<string>(
    entity === "collection" ? ((record as Collection | undefined)?.color ?? DEFAULT_COLLECTION_COLOR) : DEFAULT_COLLECTION_COLOR,
  );
  // The venue "Type" is a controlled Select posting through a hidden input, so
  // it needs its own state (was an uncontrolled native select defaultValue).
  const [venueType, setVenueType] = useState<string>(
    entity === "venue" ? ((record as Venue | undefined)?.type ?? "conference") : "conference",
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data: Record<string, unknown> = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (entity === "collection") {
      data.paperIds = collectionPaperIds;
      data.color = collectionColor;
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
    .filter((paper) => matchesSearch(paperSearchValues(paper), collectionPaperQuery)) : [];
  const papersOutsideCollection = entity === "collection" ? papers
    .filter((paper) => !collectionPaperIds.includes(paper.id))
    .filter((paper) => matchesSearch(paperSearchValues(paper), availablePaperQuery)) : [];
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
    <ModalFrame title={title} subtitle={ENTITY_SUBTITLES[entity]} onClose={onClose} className={entity === "collection" ? "collection-manager-modal" : undefined}>
      <form className="modal-body entity-form" autoComplete="off" onSubmit={submit}>
        {entity === "author" ? <>
          <label className="field-span-2"><span>Display name *</span><input name="displayName" defaultValue={author?.displayName} required autoFocus /></label>
          <label><span>Given name</span><input name="givenName" defaultValue={author?.givenName ?? ""} /></label>
          <label><span>Family name</span><input name="familyName" defaultValue={author?.familyName ?? ""} /></label>
          <label className="field-span-2"><span>Notes</span><textarea name="notes" rows={3} defaultValue={author?.notes ?? ""} /></label>
        </> : entity === "venue" ? <>
          <label className="field-span-2"><span>Full venue name *</span><input name="name" defaultValue={venue?.name} required autoFocus /></label>
          <label><span>Acronym</span><input name="acronym" defaultValue={venue?.acronym ?? ""} placeholder="NeurIPS" /></label>
          <label><span>Type</span><Select name="type" ariaLabel="Venue type" value={venueType} onChange={setVenueType} options={[{ value: "conference", label: "Conference" }, { value: "journal", label: "Journal" }, { value: "workshop", label: "Workshop" }, { value: "preprint", label: "Preprint archive" }, { value: "book", label: "Book / proceedings" }, { value: "other", label: "Other" }]} /></label>
          <label className="field-span-2"><span>Publisher or society</span><input name="publisher" defaultValue={venue?.publisher ?? ""} /></label>
          <label className="field-span-2"><span>Website</span><input name="url" type="url" defaultValue={venue?.url ?? ""} /></label>
          <label className="field-span-2"><span>Notes</span><textarea name="notes" rows={3} defaultValue={venue?.notes ?? ""} /></label>
        </> : <>
          <label className="field-span-2"><span>Collection name *</span><input name="name" defaultValue={collection?.name} required autoFocus /></label>
          <div className="field-span-2 collection-color-field">
            <span>Color</span>
            <div className="collection-color-swatches" role="radiogroup" aria-label="Collection color">
              {COLLECTION_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={collectionColor === color}
                  aria-label={color}
                  title={color}
                  className={`collection-color-swatch swatch-${color} ${collectionColor === color ? "is-selected" : ""}`}
                  onClick={() => setCollectionColor(color)}
                />
              ))}
            </div>
          </div>
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
                <ActionButton variant="secondary" size="icon" onClick={addSelectedPaperToCollection} disabled={!selectedAvailablePaperId} aria-label="Add selected paper to collection" icon={<ChevronLeft />} />
                <ActionButton variant="secondary" size="icon" onClick={removeSelectedPaperFromCollection} disabled={!selectedCollectionPaperId} aria-label="Remove selected paper from collection" icon={<ChevronRight />} />
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
              {/* The same expandable author line as the paper detail panel, so the
                  hidden names are reachable here instead of being a dead "+5". */}
              {selectedTransferPaper ? <span><b>{selectedTransferPaper.title}</b><small><AdaptiveAuthors authors={selectedTransferPaper.authors} /> · {venueLine(selectedTransferPaper)}{selectedTransferPaper.year ? ` · ${selectedTransferPaper.year}` : ""}</small></span> : <small>Select a paper to inspect it before moving.</small>}
            </div>
          </section>
        </>}
        <div className="form-actions field-span-2">
          <ActionButton variant="secondary" onClick={onClose} icon={<X />}>Cancel</ActionButton>
          <ActionButton type="submit" variant="primary" icon={editing ? <Save /> : <Plus />}>
            {editing ? `Save ${entity}` : `Create ${entity}`}
          </ActionButton>
        </div>
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
  const currentPage = Math.min(pageCount, Math.max(1, page));
  const start = total ? (currentPage - 1) * pageSize + 1 : 0;
  const end = Math.min(currentPage * pageSize, total);
  return (
    <div className="transfer-pagination">
      <span>{start}-{end} of {total}</span>
      <PaginationPageNav
        page={currentPage}
        pageCount={pageCount}
        onPageChange={onPageChange}
        label={`${label} pages`}
        className="transfer-page-nav"
        iconSize={13}
      />
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
  // "" = leave unchanged; only non-empty fields are applied (see submit).
  const [bulkVenueType, setBulkVenueType] = useState("");
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
      <form className="modal-body entity-form" autoComplete="off" onSubmit={submit}>
        {entity === "author" ? <>
          <label className="field-span-2"><span>Notes</span><textarea name="notes" rows={4} placeholder="Add shared notes" /></label>
        </> : <>
          <label><span>Type</span><Select name="type" ariaLabel="Venue type" value={bulkVenueType} onChange={setBulkVenueType} options={[{ value: "", label: "Leave unchanged" }, { value: "conference", label: "Conference" }, { value: "journal", label: "Journal" }, { value: "workshop", label: "Workshop" }, { value: "preprint", label: "Preprint archive" }, { value: "other", label: "Other" }]} /></label>
          <label><span>Publisher</span><input name="publisher" placeholder="Apply a publisher" /></label>
          <label className="field-span-2"><span>Notes</span><textarea name="notes" rows={4} placeholder="Add shared notes" /></label>
        </>}
        <div className="bulk-warning field-span-2"><Database size={16} /><span><strong>Links stay intact.</strong> These changes will be visible immediately on every related paper.</span></div>
        <div className="form-actions field-span-2">
          <ActionButton variant="secondary" onClick={onClose} icon={<X />}>Cancel</ActionButton>
          <ActionButton type="submit" variant="primary" icon={<Save />}>Apply changes</ActionButton>
        </div>
      </form>
    </ModalFrame>
  );
}

interface CommandItem {
  id: string;
  group: string;
  title: string;
  detail: string;
  icon: ReactNode;
  trailing?: ReactNode;
  run: () => void;
}

function CommandPalette({ snapshot, onClose, setView, openPaper, addPaper }: {
  snapshot: LibrarySnapshot;
  onClose: () => void;
  setView: (view: ViewId) => void;
  openPaper: (paper: Paper) => void;
  addPaper: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const items = useMemo<CommandItem[]>(() => {
    const result: CommandItem[] = [];
    if (matchesSearch(["Add a new paper", "add", "new"], query)) {
      result.push({ id: "action-add", group: "Quick actions", title: "Add a new paper", detail: "Search, URL, or manual entry", icon: <Plus size={16} />, trailing: <kbd>N</kbd>, run: addPaper });
    }
    for (const item of navigation) {
      if (!matchesSearch([item.label], query)) continue;
      const Icon = item.icon;
      result.push({ id: `view-${item.id}`, group: "Go to", title: item.label, detail: `Open the ${item.label.toLowerCase()} view`, icon: <Icon size={16} />, trailing: <ArrowRight size={15} />, run: () => setView(item.id) });
    }
    for (const paper of snapshot.papers) {
      if (result.length >= 40) break;
      if (!matchesSearch([paper.title, authorLine(paper), venueLine(paper)], query)) continue;
      result.push({ id: `paper-${paper.id}`, group: "Papers", title: paper.title, detail: `${fullAuthorLine(paper)} · ${paper.year ?? "—"}`, icon: <FileText size={16} />, trailing: <ArrowRight size={15} />, run: () => openPaper(paper) });
    }
    if (query.trim()) {
      for (const author of snapshot.authors) {
        if (result.length >= 60) break;
        if (!matchesSearch([author.displayName], query)) continue;
        result.push({ id: `author-${author.id}`, group: "Authors", title: author.displayName, detail: `${author.paperCount} ${author.paperCount === 1 ? "paper" : "papers"}`, icon: <UsersRound size={16} />, trailing: <ArrowRight size={15} />, run: () => setView("authors") });
      }
      for (const venue of snapshot.venues) {
        if (result.length >= 70) break;
        if (!matchesSearch([venue.name, venue.acronym ?? ""], query)) continue;
        result.push({ id: `venue-${venue.id}`, group: "Venues", title: venue.acronym || venue.name, detail: venue.name, icon: <Building2 size={16} />, trailing: <ArrowRight size={15} />, run: () => setView("venues") });
      }
      for (const collection of snapshot.collections) {
        if (result.length >= 80) break;
        if (!matchesSearch([collection.name], query)) continue;
        result.push({ id: `collection-${collection.id}`, group: "Collections", title: collection.name, detail: `${collection.paperCount} ${collection.paperCount === 1 ? "paper" : "papers"}`, icon: <FolderOpen size={16} />, trailing: <ArrowRight size={15} />, run: () => setView("collections") });
      }
    }
    return result;
  }, [addPaper, openPaper, query, setView, snapshot]);

  const clampedActive = items.length ? Math.min(activeIndex, items.length - 1) : 0;

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [clampedActive]);

  const runItem = (item: CommandItem | undefined) => {
    if (!item) return;
    item.run();
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (items.length ? (current + 1) % items.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (items.length ? (current - 1 + items.length) % items.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runItem(items[clampedActive]);
    }
  };

  let lastGroup = "";
  return (
    <div className="command-layer">
      <Scrim onClick={onClose} label="Close search" />
      <section className="command-card" role="dialog" aria-modal="true" aria-label="Search Stacks" onKeyDown={onKeyDown}>
        <label className="command-input">
          <Search size={19} />
          <input
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            placeholder="Search papers, authors, venues, collections…"
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={items.length ? `${listboxId}-${clampedActive}` : undefined}
          />
          <kbd>ESC</kbd>
        </label>
        <div className="command-results" role="listbox" id={listboxId} aria-label="Search results">
          {items.length ? items.map((item, index) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            const isActive = index === clampedActive;
            return (
              <Fragment key={item.id}>
                {showGroup ? <p>{item.group}</p> : null}
                <button
                  id={`${listboxId}-${index}`}
                  role="option"
                  aria-selected={isActive}
                  ref={isActive ? activeRef : undefined}
                  className={isActive ? "is-active" : ""}
                  onClick={() => runItem(item)}
                  onMouseMove={() => setActiveIndex(index)}
                >
                  <span className="command-icon">{item.icon}</span>
                  <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                  {item.trailing}
                </button>
              </Fragment>
            );
          }) : <p className="command-empty">No matches for “{query}”.</p>}
        </div>
        <div className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span>Stacks command palette</span></div>
      </section>
    </div>
  );
}
