"use client";

import { ArrowDown, ArrowLeft, BookOpen, Check, ChevronDown, ChevronRight, ChevronUp, CircleAlert, CircleCheck, CircleDot, Code2, Download, FoldVertical, FolderOpen, GitBranch, ListChecks, LoaderCircle, MoreVertical, Paperclip, Pencil, Plus, RefreshCw, Rss, Search, Square, Trash2, Undo2, Wrench, X } from "lucide-react";
import Link from "next/link";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AttachBox, type AttachSubmit, type FeedCommand, type FeedModelOption, type LibraryPaper } from "@/app/components/feed/AttachBox";
import { DEFAULT_FEED_SKILLS, type FeedSkill, feedSkillIcon } from "@/app/lib/feed-skills";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { readError, readErrorInfo } from "@/app/lib/http";
import { beginPointerResize } from "@/app/lib/pointer-resize";
import { parseJsonWith } from "@/app/lib/schemas/parse";
import { ProposalOperationSchema } from "@/app/lib/schemas/proposals";
import { SnippetAttachmentListSchema, type SnippetAttachment as FeedAttachment } from "@/app/lib/schemas/attachments";
import { Brand } from "@/app/components/ui/Brand";
import { ActionButton, Scrim } from "@/app/components/ui/controls";
import { effortSetting, type EffortSetting } from "@/app/lib/effort";
import { isClaudeAgentModel } from "@/app/lib/feed-model";
import { coalesceLegacyAgentErrors, splitFeedError } from "@/app/lib/feed-errors";
import { feedMarkdown } from "@/app/lib/feed-export";
import { ThemeToggle } from "@/app/components/ui/ThemeToggle";
import { groupFeedInteractions, interactionsBefore, OPENING_INTERACTION_ID, type FeedInteraction } from "@/app/lib/feed-history";

interface FeedMessage {
  id: string;
  role: string;
  kind: string;
  content: string;
  toolUseId?: string | null;
  attachments?: string | null;
  // The usage the CLI reported for the turn this message concludes. Absent (or 0)
  // on user turns, on tool traffic, and on threads recorded before it was stored.
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  createdAt: string;
}

interface FeedProposal {
  id: string;
  messageId?: string | null;
  operation: string;
  status: string;
  summary: string;
  createdAt: string;
}

interface FeedSnapshot {
  messages: FeedMessage[];
  proposals: FeedProposal[];
}

interface FeedToolOperation {
  id: string;
  label: string;
  input?: string;
  result?: string;
}

const FEED_HISTORY_WINDOW = 8;

/** A meta chip on a proposal card. The `action` chip (e.g. "Create paper") is
 *  the primary, brand-tinted label; the rest (paper type, venue) are neutral. */
interface ProposalTag {
  label: string;
  kind: "action" | "meta";
}

/** Parse a proposal's operation JSON into the chips shown on its card: the
 *  action + entity ("Create paper"), and for papers the type and venue. */
function proposalTags(operation: string): ProposalTag[] {
  const parsed = parseJsonWith(ProposalOperationSchema, operation);
  if (!parsed.ok) {
    return [];
  }
  const op = parsed.data;
  const tags: ProposalTag[] = [
    { label: `${op.action.charAt(0).toUpperCase()}${op.action.slice(1)} ${op.entity}`, kind: "action" },
  ];
  const data = "data" in op ? op.data : {};
  if (op.entity === "paper") {
    const type = typeof data.paperType === "string" ? data.paperType : "";
    if (type) tags.push({ label: type, kind: "meta" });
    const venue = typeof data.venueAcronym === "string" && data.venueAcronym
      ? data.venueAcronym
      : typeof data.venueName === "string" ? data.venueName : "";
    if (venue) tags.push({ label: venue, kind: "meta" });
  }
  return tags;
}

/** "venueAcronym" → "Venue acronym" for the structured proposal fields. */
function fieldLabel(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Render a proposal data value as a readable line (arrays joined, objects as JSON). */
function fieldValue(value: unknown, describe?: (id: string) => { label: string }): string {
  const name = (item: string) => describe?.(item).label ?? item;
  if (typeof value === "string") return name(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? name(item) : JSON.stringify(item))).join(", ");
  return JSON.stringify(value);
}

/** Fields whose values are record ids, so they read as names in the details. */
const ID_FIELDS = new Set(["paperIds", "addPaperIds", "removePaperIds", "collectionIds"]);

/** The expanded view of a proposal card: the operation's fields as labeled rows,
 *  with the raw JSON tucked in a collapsible block underneath (this replaces the
 *  separate "Proposed changes (raw)" dump that used to sit next to the cards). */
function ProposalDetails({ operation, feedId, feedName, describeTarget }: {
  operation: string;
  feedId: string;
  feedName: string;
  describeTarget?: (id: string) => { label: string; meta?: string };
}) {
  // Validated against the shared proposal schema rather than a local interface
  // plus a cast, so this renders only shapes the approval path would accept.
  const parsed = parseJsonWith(ProposalOperationSchema, operation);
  const op = parsed.ok ? parsed.data : null;
  let pretty = operation;
  if (op) {
    pretty = JSON.stringify(op, null, 2);
  }
  const data = op && "data" in op ? op.data : {};
  const fields = Object.entries(data ?? {}).filter(([, value]) => value !== null && value !== undefined && value !== "");
  return (
    <div className="feed-proposal-detail">
      {op ? (
        <div className="feed-proposal-fields">
          <div className="feed-proposal-field">
            <span>Action</span>
            <strong><span className="feed-proposal-tag feed-proposal-tag-action">{`${op.action} ${op.entity}`}</span></strong>
          </div>
          {"id" in op ? (() => {
            const target = describeTarget?.(op.id) ?? { label: op.id };
            return (
              <div className="feed-proposal-field">
                <span>Target</span>
                <strong>{target.label}{target.meta ? <small className="feed-proposal-target-meta">{target.meta}</small> : null}</strong>
              </div>
            );
          })() : null}
          {fields.map(([key, value]) => (
            <div key={key} className="feed-proposal-field">
              <span>{fieldLabel(key)}</span>
              <strong>{fieldValue(value, ID_FIELDS.has(key) ? describeTarget : undefined)}</strong>
            </div>
          ))}
        </div>
      ) : null}
      <details className="feed-tool-call feed-proposal-json">
        <summary><Code2 size={12} /> <span>Raw JSON</span></summary>
        <div className="feed-tool-io"><MarkdownContent content={toolFence(pretty, "json")} className="feed-tool-md" enableFeedRichContent feedId={feedId} feedName={feedName} /></div>
      </details>
    </div>
  );
}

interface FeedSnippet {
  id: string;
  title: string;
  instruction: string;
  status: string;
  model?: string | null;
  effort?: string | null;
  error: string | null;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  turns?: number;
  attachments?: string | null;
  /** Set on a feed that was compacted out of another one. */
  compactedFromId?: string | null;
  pendingProposals?: number;
  collapsed?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Parse the stored attachments JSON (tolerant of nulls / malformed rows). */
function parseAttachments(raw: string | null | undefined): FeedAttachment[] {
  if (!raw) return [];
  const parsed = parseJsonWith(SnippetAttachmentListSchema, raw);
  return parsed.ok ? parsed.data : [];
}

/** Render clickable chips for a turn's attachments (download via the feed route). */
function AttachmentChips({ snippetId, attachments }: { snippetId: string; attachments: FeedAttachment[] }) {
  const [viewing, setViewing] = useState<{ label: string; content: string } | null>(null);
  const [loading, setLoading] = useState(false);
  if (!attachments.length) return null;

  async function openText(name: string, label: string) {
    setLoading(true);
    try {
      const response = await fetch(`/api/feed/snippets/${snippetId}/attachments/${encodeURIComponent(name)}`);
      const content = response.ok ? await response.text() : "This attachment could not be loaded.";
      setViewing({ label, content });
    } catch {
      setViewing({ label, content: "This attachment could not be loaded." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="feed-turn-attachments">
        {attachments.map((attachment, index) => {
          // A referenced library paper: opens that paper in the library in a new
          // tab (the deep link is consumed by Stacks on load), keeping the feed
          // thread in place.
          if (attachment.kind === "paper") {
            const href = attachment.paperId ? `/?paper=${encodeURIComponent(attachment.paperId)}` : "/";
            return (
              <a key={attachment.paperId ?? `paper-${index}`} href={href} target="_blank" rel="noreferrer" className="feed-turn-attachment" title={`Open ${attachment.label} in your library`}>
                <BookOpen size={12} />
                <span>{attachment.label}</span>
              </a>
            );
          }
          // Uploads (and legacy staged paper copies) are files in the working dir.
          const name = attachment.relativePath?.split("/").pop() ?? attachment.label;
          const href = `/api/feed/snippets/${snippetId}/attachments/${encodeURIComponent(name)}`;
          // Pasted/short text opens an in-app viewer (like the composer's text
          // editor); binary files (PDF/HTML/image) open in a new tab.
          const isText = /\.(txt|md|markdown)$/i.test(name);
          if (isText) {
            return (
              <button type="button" key={attachment.relativePath ?? `file-${index}`} className="feed-turn-attachment" onClick={() => void openText(name, attachment.label)} disabled={loading} title={`View ${attachment.label}`}>
                <Paperclip size={12} />
                <span>{attachment.label}</span>
              </button>
            );
          }
          return (
            <a key={attachment.relativePath ?? `file-${index}`} href={href} target="_blank" rel="noreferrer" className="feed-turn-attachment" title={`Open ${attachment.label}`}>
              <Paperclip size={12} />
              <span>{attachment.label}</span>
            </a>
          );
        })}
      </div>
      {viewing ? (
        <div className="feed-picker-scrim" onClick={() => setViewing(null)}>
          <div className="feed-picker feed-text-editor" onClick={(event) => event.stopPropagation()}>
            <header className="feed-picker-head">
              <strong>{viewing.label}</strong>
              <button type="button" className="feed-tool-btn" onClick={() => setViewing(null)} aria-label="Close"><X size={16} /></button>
            </header>
            <textarea className="feed-text-editor-area" value={viewing.content} readOnly />
          </div>
        </div>
      ) : null}
    </>
  );
}

// Persistent GitHub-sync activity log (localStorage, survives reloads) so the
// user can review past sync outcomes, not just the last transient notice.
interface SyncLogEntry {
  id: string;
  at: number;
  status: "success" | "error" | "paused";
  summary: string;
  details?: string;
}
const SYNC_LOG_KEY = "stacks-sync-log-v1";

function readSyncLog(): SyncLogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SYNC_LOG_KEY) || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is SyncLogEntry => Boolean(
        entry && typeof entry === "object"
        && typeof (entry as SyncLogEntry).id === "string"
        && typeof (entry as SyncLogEntry).at === "number"
        && (["success", "error", "paused"] as const).includes((entry as SyncLogEntry).status)
        && typeof (entry as SyncLogEntry).summary === "string",
      ))
      .map((entry) => ({
        ...entry,
        details: typeof entry.details === "string" ? entry.details : undefined,
      }))
      .slice(0, 50);
  } catch {
    return [];
  }
}

function writeSyncLog(entries: SyncLogEntry[]): void {
  try {
    window.localStorage.setItem(SYNC_LOG_KEY, JSON.stringify(entries.slice(0, 50)));
  } catch {
    // A full/blocked storage quota must not break syncing.
  }
}

function syncDiagnosticText(entry: SyncLogEntry): string {
  if (entry.details) return entry.details;
  const legacyNote = entry.summary.startsWith("GitHub API ")
    ? "This entry was captured by an older Stacks version, which truncated GitHub's response before saving it. Run sync again to capture complete diagnostics."
    : "No additional diagnostics were returned.";
  return `${entry.summary}\n\n${legacyNote}`;
}

/**
 * The feed's Sync activity dock: the exact .background-task-* chrome from the
 * main-page Activity (its own row, popover opens upward), so the two match.
 */
function SyncActivityDock({ log, onClear }: { log: SyncLogEntry[]; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <aside className={`background-task-dock ${open ? "is-open" : ""}`} aria-label="Sync activity">
      {open ? (
        <div className="background-task-panel">
          <header>
            <span><ListChecks size={16} /><strong>Sync activity</strong></span>
            <div>
              <button type="button" className="activity-clear" onClick={onClear} disabled={!log.length}>Clear</button>
              <button type="button" onClick={() => setOpen(false)} aria-label="Collapse sync activity"><X size={15} /></button>
            </div>
          </header>
          <div className="background-task-list">
            {!log.length ? <p className="activity-log-empty">No syncs yet.</p> : log.map((entry) => (
              <div className={`background-task-row is-${entry.status === "success" ? "complete" : entry.status === "paused" ? "running" : "error"}`} key={entry.id}>
                {entry.status === "success" ? <CircleCheck size={16} /> : entry.status === "paused" ? <CircleDot size={16} /> : <CircleAlert size={16} />}
                <span>
                  <strong>{entry.summary}</strong>
                  <small>{entry.status === "success" ? "Completed" : entry.status === "paused" ? "Paused safely" : "Needs attention"} · {new Date(entry.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small>
                  {entry.status === "error" ? (
                    <details className="background-task-diagnostics">
                      <summary>
                        <ChevronRight className="disclosure-chevron" size={12} aria-hidden="true" />
                        Technical details
                      </summary>
                      <pre>{syncDiagnosticText(entry)}</pre>
                    </details>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <button type="button" className="background-task-trigger" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ListChecks size={17} />
        <span>Activity</span>
        <ChevronUp size={14} />
      </button>
    </aside>
  );
}

/** Sync failures use the same standalone toast surface as Settings instead of
 * becoming another nested card inside the feed sidebar. */
function SyncFailureToast({ failure, onDismiss }: { failure: { summary: string; details: string }; onDismiss: () => void }) {
  return (
    <div className="toast toast-error feed-sync-toast">
      <span className="toast-message" role="alert">
        <CircleAlert size={17} aria-hidden="true" />
        <span className="feed-sync-toast-content">
          <strong>{failure.summary}</strong>
          {failure.details ? (
            <details className="feed-error-details">
              <summary>
                <ChevronRight className="disclosure-chevron" size={14} aria-hidden="true" />
                <span>Technical details</span>
              </summary>
              <pre>{failure.details}</pre>
            </details>
          ) : null}
        </span>
      </span>
      <button type="button" className="toast-dismiss" onClick={onDismiss} aria-label="Dismiss notification">
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

// The agent emits its proposed changes as a fenced ```stacks-proposals JSON
// block. That block is machine markup already parsed into the approve/reject
// cards, so it doesn't belong inline in the prose bubble. Split it out: render
// the prose normally, and offer the raw JSON in a collapsible block (like a
// tool call) for anyone who wants to inspect it.
function splitProposalBlock(content: string): { prose: string; raw: string | null } {
  const blocks: string[] = [];
  const prose = content
    .replace(/```(?:stacks|pa)-proposals\s*([\s\S]*?)```/gi, (_match, body: string) => {
      blocks.push(body.trim());
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { prose, raw: blocks.length ? blocks.join("\n\n") : null };
}

function statusLabel(status: string): string {
  switch (status) {
    case "running": return "Working…";
    case "queued": return "Queued";
    case "done": return "Done";
    case "error": return "Error";
    case "stopped": return "Stopped";
    default: return status;
  }
}

/** A status glyph shared by the list row and the detail header, so each state
 *  (working/queued/done/error/stopped) reads with the same icon everywhere. */
function StatusGlyph({ status, size = 13 }: { status: string; size?: number }) {
  if (status === "running" || status === "queued") {
    return <LoaderCircle className="spin" size={size} />;
  }
  if (status === "error") {
    return <CircleAlert size={size} />;
  }
  if (status === "stopped") {
    return <Square size={size} />;
  }
  if (status === "done") {
    return <CircleCheck size={size} />;
  }
  return <CircleDot size={size} />;
}

/**
 * Guess a fence language from tool I/O so it highlights correctly. We label
 * explicitly (rather than letting highlight.js auto-detect) because auto-detect
 * mistakes JSON-with-URLs for JavaScript and renders `//host` as a comment.
 */
function guessLang(text: string): string {
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed) && /[:[\]{}]/.test(trimmed)) return "json";
  if (/^(curl|cat|ls|cd|grep|rg|npm|npx|node|python3?|git|echo|mkdir|rm|mv|cp|sed|awk|find|which|export)\b/m.test(trimmed) || /\s\|\s|&&|\$\(/.test(trimmed)) return "bash";
  return "";
}

/**
 * Wrap raw tool I/O in a fenced code block so it renders (and highlights)
 * through Markdown. The fence is longer than any backtick run in the content,
 * so embedded backticks can't break out.
 */
function toolFence(content: string, lang = guessLang(content)): string {
  const longest = (content.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${content.replace(/\s+$/, "")}\n${fence}`;
}

/** Tool request/result body: highlighted markdown, or a muted note if empty. */
function renderToolContent(content: string, feedId: string, feedName: string): ReactNode {
  if (!content.trim()) {
    return <p className="feed-tool-empty">No output</p>;
  }
  return <MarkdownContent content={toolFence(content)} className="feed-tool-md" enableFeedRichContent feedId={feedId} feedName={feedName} />;
}

/**
 * Keep expensive Markdown/highlighting out of the tree until the user opens a
 * tool operation. Native <details> hides its descendants visually but React
 * would otherwise still parse and mount every multi-kilobyte request/result.
 */
const FeedToolCall = memo(function FeedToolCall({ operation, feedId, feedName }: {
  operation: FeedToolOperation;
  feedId: string;
  feedName: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details className="feed-tool-call" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary><Wrench size={12} /> <span>{operation.label}</span></summary>
      {expanded ? (
        <div className="feed-tool-io">
          {operation.input !== undefined ? (
            <>
              <span className="feed-tool-tag">Request</span>
              {renderToolContent(operation.input, feedId, feedName)}
            </>
          ) : null}
          {operation.result !== undefined ? (
            <>
              <span className="feed-tool-tag">Result</span>
              {renderToolContent(operation.result, feedId, feedName)}
            </>
          ) : null}
        </div>
      ) : null}
    </details>
  );
});

/** A consecutive run of tools mounts only its count until the group is opened. */
const FeedToolGroup = memo(function FeedToolGroup({ operations, feedId, feedName }: {
  operations: FeedToolOperation[];
  feedId: string;
  feedName: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details className="feed-tool-group" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <ChevronRight className="disclosure-chevron" size={14} aria-hidden="true" />
        <Wrench size={13} />
        <span>{operations.length} tool operations</span>
      </summary>
      {expanded ? (
        <div className="feed-tool-group-items">
          {operations.map((operation) => (
            <FeedToolCall key={operation.id} operation={operation} feedId={feedId} feedName={feedName} />
          ))}
        </div>
      ) : null}
    </details>
  );
});

function FeedErrorMessage({ content, announce = false }: { content: string; announce?: boolean }) {
  const { summary, details } = splitFeedError(content);
  return (
    <div className="feed-error" role={announce ? "alert" : undefined}>
      <CircleAlert size={14} aria-hidden="true" />
      <div className="feed-error-content">
        <span className="feed-error-summary">{summary}</span>
        {details ? (
          <details className="feed-error-details">
            <summary>
              <ChevronRight className="disclosure-chevron" size={14} aria-hidden="true" />
              <span>Technical details</span>
            </summary>
            <pre>{details}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** Compact token count with a scale that remains readable for long feeds. */
function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

/** Duration in ms → "3.4s" / "1m 12s". */
function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const mins = Math.floor(seconds / 60);
  return `${mins}m ${Math.round(seconds - mins * 60)}s`;
}

/** The stat line shown in the detail header: tokens, duration, turns. */
function snippetStats(snippet: FeedSnippet): string[] {
  const stats: string[] = [];
  const tokens = (snippet.inputTokens ?? 0) + (snippet.outputTokens ?? 0);
  if (tokens) stats.push(`${compactTokens(tokens)} tokens`);
  if (snippet.durationMs) stats.push(formatDuration(snippet.durationMs));
  if (snippet.turns) stats.push(`${snippet.turns} ${snippet.turns === 1 ? "turn" : "turns"}`);
  return stats;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? "hour" : "hours"} ago`;
  return new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
}

/** A compact, readable age for space-constrained feed rows. */
function compactRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr`;
  return new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
}

/** Full local date+time, for the exact-timestamp tooltips. */
function fullTime(iso: string): string {
  return new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
}

/** Generated tokens per second, kept to three significant figures. */
function formatSpeed(tokensPerSecond: number): string {
  if (tokensPerSecond < 10) return tokensPerSecond.toFixed(2);
  return tokensPerSecond.toFixed(tokensPerSecond < 100 ? 1 : 0);
}

/**
 * The footer of a turn: when it was written, and for an agent reply the usage the
 * CLI reported for that turn. Set as quiet text rather than chips, since it is
 * provenance for the reply above it, not content. The stored stamp is UTC and
 * toLocaleString renders it in the reader's own zone. A reply recorded before
 * per-turn usage was stored shows its time alone.
 */
function TurnMeta({ iso, message, onRetry, onFork, onRewind, busy = false }: {
  iso: string;
  message?: FeedMessage;
  /** All three act on this turn: retry asks it again, fork continues from just
   *  before it in a copy, and rewind takes this thread back to before it. */
  onRetry?: () => void;
  onFork?: () => void;
  onRewind?: () => void;
  busy?: boolean;
}) {
  const inputTokens = message?.inputTokens ?? 0;
  const outputTokens = message?.outputTokens ?? 0;
  const durationMs = message?.durationMs ?? 0;
  const speed = outputTokens && durationMs ? outputTokens / (durationMs / 1000) : 0;
  return (
    <div className="feed-turn-meta">
      {onRetry ? (
        <button
          type="button"
          className="feed-turn-action"
          onClick={onRetry}
          disabled={busy}
          title="Ask this again and replace the answer below it"
        >
          {busy ? <LoaderCircle className="spin" size={11} aria-hidden="true" /> : <RefreshCw size={11} aria-hidden="true" />}
          Retry
        </button>
      ) : null}
      {onFork ? (
        <button
          type="button"
          className="feed-turn-action"
          onClick={onFork}
          disabled={busy}
          title="Continue from before this message in a new feed"
        >
          <GitBranch size={11} aria-hidden="true" />
          Fork
        </button>
      ) : null}
      {onRewind ? (
        <button
          type="button"
          className="feed-turn-action"
          onClick={onRewind}
          disabled={busy}
          title="Take this thread back to before this message"
        >
          <Undo2 size={11} aria-hidden="true" />
          Rewind
        </button>
      ) : null}
      <time className="feed-turn-metric" dateTime={iso}>{fullTime(iso)}</time>
      {speed ? <span className="feed-turn-metric">{formatSpeed(speed)} tok/sec</span> : null}
      {outputTokens ? (
        <span className="feed-turn-metric" title={`${inputTokens.toLocaleString("en")} prompt tokens, ${outputTokens.toLocaleString("en")} generated`}>
          {compactTokens(outputTokens)} tokens
        </span>
      ) : null}
      {durationMs ? <span className="feed-turn-metric">{formatDuration(durationMs)}</span> : null}
    </div>
  );
}

/**
 * A single row in the left list: status glyph, title, and a relative timestamp,
 * on one line so the console scales to dozens of interactions, plus an overflow
 * menu (rename / fork / export / delete). Statuses stay fresh via the poll.
 */
function FeedRow({ snippet, active, onSelect, onRename, onFork, onSelectHistory, onExport, onCollapse, onDelete }: {
  snippet: FeedSnippet;
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onFork: () => void;
  onSelectHistory: (returnFocus: HTMLButtonElement | null) => void;
  onExport: () => void;
  onCollapse: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const kebabRef = useRef<HTMLButtonElement>(null);
  const rowButtonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    // The menu is portaled out of the scrolling list, so close it if the list
    // scrolls or the window resizes rather than letting it float detached.
    const dismiss = () => setMenuOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [menuOpen]);

  function toggleMenu() {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const rect = kebabRef.current?.getBoundingClientRect();
    if (rect) {
      // Open downward, but flip above the kebab when the menu (~6 items) would
      // run past the viewport bottom, so the last item is never clipped.
      const menuHeight = 252;
      const right = window.innerWidth - rect.right;
      if (rect.bottom + 4 + menuHeight > window.innerHeight) {
        setMenuPos({ bottom: window.innerHeight - rect.top + 4, right });
      } else {
        setMenuPos({ top: rect.bottom + 4, right });
      }
    }
    setMenuOpen(true);
  }

  const run = (action: () => void) => () => { setMenuOpen(false); action(); };

  return (
    <div className={`feed-row feed-row-${snippet.status} ${active ? "is-active" : ""} ${menuOpen ? "menu-open" : ""}`}>
      <button ref={rowButtonRef} type="button" className="feed-row-main" onClick={onSelect} aria-current={active}>
        <span className={`feed-row-glyph feed-status-${snippet.status}`}><StatusGlyph status={snippet.status} /></span>
        <span className="feed-row-body">
          <span className="feed-row-title-line">
            <span className="feed-row-title">{snippet.title || snippet.instruction || "Untitled"}</span>
          </span>
          <span className="feed-row-meta">
            <span className={`feed-row-status feed-status-${snippet.status}`}>{statusLabel(snippet.status)}</span>
            <span
              className="feed-row-time"
              aria-label={`Updated ${relativeTime(snippet.updatedAt)}`}
              title={`Updated ${fullTime(snippet.updatedAt)}`}
            >
              {compactRelativeTime(snippet.updatedAt)}
            </span>
            {(() => {
              const tokens = (snippet.inputTokens ?? 0) + (snippet.outputTokens ?? 0);
              return tokens ? (
                <span aria-label={`${tokens.toLocaleString()} tokens used`} title={`${tokens.toLocaleString()} tokens used`}>
                  {compactTokens(tokens)} tokens
                </span>
              ) : null;
            })()}
            {snippet.turns ? <span>{snippet.turns} {snippet.turns === 1 ? "turn" : "turns"}</span> : null}
            {snippet.pendingProposals ? <span className="feed-row-pending" title={`${snippet.pendingProposals} change${snippet.pendingProposals === 1 ? "" : "s"} to approve`}>{snippet.pendingProposals}</span> : null}
          </span>
        </span>
      </button>
      <div className="feed-row-menu" ref={menuRef}>
        <button ref={kebabRef} type="button" className="feed-row-kebab" onClick={toggleMenu} aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen}><MoreVertical size={15} /></button>
        {menuOpen && menuPos
          ? createPortal(
              <div ref={listRef} className="feed-row-menu-list" role="menu" style={{ position: "fixed", top: menuPos.top, bottom: menuPos.bottom, right: menuPos.right }}>
                <button type="button" role="menuitem" onClick={run(onRename)}><Pencil size={14} /> Rename</button>
                <button type="button" role="menuitem" onClick={run(onFork)}><GitBranch size={14} /> Fork</button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={snippet.status === "running" || snippet.status === "queued"}
                  onClick={() => {
                    setMenuOpen(false);
                    onSelectHistory(rowButtonRef.current);
                  }}
                >
                  <ListChecks size={14} /> Select history
                </button>
                <button type="button" role="menuitem" onClick={run(onExport)}><Download size={14} /> Export</button>
                <button type="button" role="menuitem" onClick={run(onCollapse)}>{snippet.collapsed ? <><ChevronUp size={14} /> Expand</> : <><ChevronDown size={14} /> Collapse</>}</button>
                <button type="button" role="menuitem" className="is-danger" onClick={run(onDelete)}><Trash2 size={14} /> Delete</button>
              </div>,
              document.body,
            )
          : null}
      </div>
    </div>
  );
}

interface FeedHistorySelectionModalProps {
  feedName: string;
  interactions: FeedInteraction<FeedMessage>[];
  selected: Set<string>;
  includeToolDetails: boolean;
  creating: boolean;
  loading: boolean;
  error: string | null;
  returnFocus: HTMLButtonElement | null;
  onToggle: (id: string) => void;
  onSetVisible: (ids: string[], selected: boolean) => void;
  onIncludeToolDetails: (include: boolean) => void;
  onClose: () => void;
  onCreate: () => void;
  onJump: (id: string) => void;
}

function interactionResponseText(interaction: FeedInteraction<FeedMessage>): string {
  return interaction.messages
    .filter((message) => message.role === "assistant" && ["text", "result", "error"].includes(message.kind))
    .map((message) => message.kind === "error" ? message.content : splitProposalBlock(message.content).prose)
    .filter((content) => content.trim())
    .join("\n\n");
}

const FEED_HISTORY_REQUEST_PREVIEW_LENGTH = 800;
const FEED_HISTORY_RESPONSE_PREVIEW_LENGTH = 2_000;
const FEED_HISTORY_JUMP_DURATION_MS = 260;

function cappedHistoryPreview(content: string, limit: number): string {
  const trimmed = content.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit).trimEnd()}…`;
}

/**
 * A focused chooser for creating a new feed from past requests. The complete,
 * lightweight request index stays available on the left while the complete
 * chronological request/response list remains visible on the right. Collapsed
 * previews use bounded strings and CSS rendering containment so a long history
 * does not become a second full conversation DOM.
 */
function FeedHistorySelectionModal({
  feedName,
  interactions,
  selected,
  includeToolDetails,
  creating,
  loading,
  error,
  returnFocus,
  onToggle,
  onSetVisible,
  onIncludeToolDetails,
  onClose,
  onCreate,
  onJump,
}: FeedHistorySelectionModalProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [expandedRequests, setExpandedRequests] = useState<Set<string>>(() => new Set());
  const [activeInteractionId, setActiveInteractionId] = useState(interactions[0]?.id ?? "");
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const indexButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const interactionsPaneRef = useRef<HTMLDivElement>(null);
  const interactionCardRefs = useRef(new Map<string, HTMLElement>());
  const historyScrollFrameRef = useRef<number | null>(null);
  const closeRef = useRef(onClose);
  const creatingRef = useRef(creating);

  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => { creatingRef.current = creating; }, [creating]);

  const records = useMemo(() => interactions.map((interaction, index) => {
    const response = interactionResponseText(interaction);
    return {
      interaction,
      number: index + 1,
      response,
      searchText: `${interaction.userText}\n${response}`.toLocaleLowerCase(),
    };
  }), [interactions]);
  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return records;
    return records.filter(({ searchText }) => searchText.includes(term));
  }, [query, records]);
  const visibleIds = visible.map(({ interaction }) => interaction.id);
  const displayedActiveId = visibleIds.includes(activeInteractionId) ? activeInteractionId : (visibleIds[0] ?? "");
  const allVisibleSelected = Boolean(visibleIds.length) && visibleIds.every((id) => selected.has(id));

  useEffect(() => {
    indexButtonRefs.current.get(displayedActiveId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [displayedActiveId]);

  useEffect(() => {
    const pane = interactionsPaneRef.current;
    if (!pane) return;
    const cancelAnimatedScroll = () => {
      if (historyScrollFrameRef.current === null) return;
      cancelAnimationFrame(historyScrollFrameRef.current);
      historyScrollFrameRef.current = null;
    };
    pane.addEventListener("wheel", cancelAnimatedScroll, { passive: true });
    pane.addEventListener("touchstart", cancelAnimatedScroll, { passive: true });
    pane.addEventListener("pointerdown", cancelAnimatedScroll);
    return () => {
      cancelAnimatedScroll();
      pane.removeEventListener("wheel", cancelAnimatedScroll);
      pane.removeEventListener("touchstart", cancelAnimatedScroll);
      pane.removeEventListener("pointerdown", cancelAnimatedScroll);
    };
  }, []);

  useEffect(() => {
    const page = document.querySelector<HTMLElement>(".feed-page");
    const pageWasInert = page?.inert ?? false;
    const oldOverflow = document.body.style.overflow;
    if (page) page.inert = true;
    document.body.style.overflow = "hidden";

    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!creatingRef.current) closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
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
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      if (page) page.inert = pageWasInert;
      document.body.style.overflow = oldOverflow;
      const focusTarget = returnFocus?.offsetParent
        ? returnFocus
        : document.querySelector<HTMLButtonElement>(".feed-detail-back");
      focusTarget?.focus();
    };
  }, [returnFocus]);

  function jumpWithinModal(id: string) {
    setActiveInteractionId(id);
    const pane = interactionsPaneRef.current;
    const card = interactionCardRefs.current.get(id);
    if (!pane || !card) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const paneTop = pane.getBoundingClientRect().top;
    const cardTop = card.getBoundingClientRect().top;
    const targetTop = Math.min(
      pane.scrollHeight - pane.clientHeight,
      Math.max(0, pane.scrollTop + cardTop - paneTop),
    );
    if (historyScrollFrameRef.current !== null) cancelAnimationFrame(historyScrollFrameRef.current);
    if (reduceMotion) {
      pane.scrollTop = targetTop;
      historyScrollFrameRef.current = null;
      return;
    }
    const startTop = pane.scrollTop;
    const distance = targetTop - startTop;
    let startTime: number | null = null;
    const animate = (time: number) => {
      startTime ??= time;
      const progress = Math.min(1, (time - startTime) / FEED_HISTORY_JUMP_DURATION_MS);
      const eased = 1 - ((1 - progress) ** 3);
      pane.scrollTop = startTop + (distance * eased);
      historyScrollFrameRef.current = progress < 1 ? requestAnimationFrame(animate) : null;
    };
    historyScrollFrameRef.current = requestAnimationFrame(animate);
  }

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleRequestExpanded(id: string) {
    setExpandedRequests((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="feed-history-modal-layer">
      <Scrim onClick={() => { if (!creating) onClose(); }} label="Close history selection" />
      <section
        ref={dialogRef}
        className="feed-history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feed-history-title"
        aria-describedby="feed-history-description"
      >
        <header className="feed-history-modal-head">
          <div>
            <span className="feed-history-modal-kicker">{feedName}</span>
            <h2 id="feed-history-title">Select history</h2>
            <p id="feed-history-description">Requests you pick carry their response and the work that followed into a new feed.</p>
          </div>
          <ActionButton variant="ghost" size="icon" onClick={onClose} disabled={creating} aria-label="Close" icon={<X />} />
        </header>

        <div className="feed-history-toolbar">
          <label className="feed-history-search">
            <Search size={16} aria-hidden="true" />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search requests and responses…" />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={14} /></button> : null}
          </label>
          <div className="feed-history-bulk-actions">
            <button type="button" disabled={!visibleIds.length || loading} onClick={() => onSetVisible(visibleIds, !allVisibleSelected)}>
              {allVisibleSelected ? "Clear shown" : "Select shown"}
            </button>
            <button type="button" disabled={!selected.size} onClick={() => onSetVisible([...selected], false)}>Clear all</button>
          </div>
        </div>

        <div className="feed-history-modal-body">
          <nav className="feed-history-index" aria-label="Jump to a user request">
            <span>Requests</span>
            <div className="feed-history-index-list">
              {visible.map(({ interaction, number }) => (
                <div
                  key={interaction.id}
                  className={`feed-history-index-row ${displayedActiveId === interaction.id ? "is-active" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(interaction.id)}
                    disabled={loading}
                    onChange={() => onToggle(interaction.id)}
                    aria-label={`Select request ${number} from the request list`}
                  />
                  <button
                    type="button"
                    ref={(node) => {
                      if (node) indexButtonRefs.current.set(interaction.id, node);
                      else indexButtonRefs.current.delete(interaction.id);
                    }}
                    onClick={() => jumpWithinModal(interaction.id)}
                    aria-label={`Jump to request ${number}`}
                    aria-current={displayedActiveId === interaction.id ? "true" : undefined}
                  >
                    <b>{number}</b>
                    <span>{interaction.userText.trim() || "Request with attachments"}</span>
                  </button>
                </div>
              ))}
            </div>
          </nav>

          <div ref={interactionsPaneRef} className="feed-history-interactions" aria-busy={loading}>
            {loading ? (
              <div className="feed-history-loading"><LoaderCircle className="spin" size={18} /><span>Loading conversation history…</span></div>
            ) : visible.length ? visible.map(({ interaction, number, response }) => {
              const isExpanded = expanded.has(interaction.id);
              const isRequestExpanded = expandedRequests.has(interaction.id);
              const isSelected = selected.has(interaction.id);
              const requestCanExpand = interaction.userText.length > 180 || interaction.userText.split("\n").length > 3;
              const requestText = interaction.userText.trim() || "Request with attachments";
              const requestPreview = isRequestExpanded
                ? requestText
                : cappedHistoryPreview(requestText, FEED_HISTORY_REQUEST_PREVIEW_LENGTH);
              const responsePreview = isExpanded
                ? response
                : cappedHistoryPreview(response, FEED_HISTORY_RESPONSE_PREVIEW_LENGTH);
              return (
                <article
                  key={interaction.id}
                  ref={(node) => {
                    if (node) interactionCardRefs.current.set(interaction.id, node);
                    else interactionCardRefs.current.delete(interaction.id);
                  }}
                  className={`feed-history-interaction ${isSelected ? "is-selected" : ""}`}
                >
                  <label className="feed-history-interaction-select">
                    <input type="checkbox" checked={isSelected} disabled={loading} onChange={() => onToggle(interaction.id)} />
                    <span>Request {number}</span>
                  </label>
                  <div className="feed-history-request-preview">
                    <strong>You</strong>
                    <p className={isRequestExpanded ? "is-expanded" : ""}>{requestPreview}</p>
                  </div>
                  <div className="feed-history-response-preview">
                    <strong>Agent response</strong>
                    <p className={isExpanded ? "is-expanded" : ""}>{responsePreview || "No agent response before the next request."}</p>
                  </div>
                  <div className="feed-history-interaction-actions">
                    <span className="feed-history-expand-actions">
                      {requestCanExpand ? (
                        <button type="button" onClick={() => toggleRequestExpanded(interaction.id)} aria-expanded={isRequestExpanded}>
                          {isRequestExpanded ? "Collapse request" : "Show full request"}
                        </button>
                      ) : null}
                      {response ? (
                        <button type="button" onClick={() => toggleExpanded(interaction.id)} aria-expanded={isExpanded}>
                          {isExpanded ? "Collapse response" : "Show full response"}
                        </button>
                      ) : null}
                    </span>
                    <button type="button" onClick={() => onJump(interaction.id)}>View in feed</button>
                  </div>
                </article>
              );
            }) : (
              <div className="feed-history-empty">No requests or responses match “{query}”.</div>
            )}
          </div>
        </div>

        {error ? <div className="feed-history-modal-error" role="alert"><CircleAlert size={15} /> {error}</div> : null}
        <footer className="feed-history-modal-foot">
          <div className="feed-history-selection-copy" aria-live="polite">
            <strong>{selected.size} request{selected.size === 1 ? "" : "s"} selected</strong>
            <span>In chronological order.</span>
          </div>
          <label className="feed-history-tool-toggle">
            <input type="checkbox" checked={includeToolDetails} onChange={(event) => onIncludeToolDetails(event.target.checked)} />
            Include tool calls
          </label>
          <ActionButton variant="secondary" size="small" onClick={onClose} disabled={creating}>Cancel</ActionButton>
          <ActionButton variant="primary" size="small" disabled={!selected.size || creating || loading} onClick={onCreate} icon={creating ? <LoaderCircle className="spin" /> : <GitBranch />}>
            Create feed
          </ActionButton>
        </footer>
      </section>
    </div>
  );
}

/**
 * The right detail pane: the selected snippet's full thread. Streams its own SSE
 * (history is replayed on connect, so any snippet — live or long-finished — fills
 * in), shows proposals to approve/reject, and offers a reply box. Mounted with a
 * `key` of the snippet id so switching selection resets its state cleanly.
 */
function FeedDetail({ snippet, library, collections, models, defaultModelLabel, defaultEffort, historySelectionRequest, onHistorySelectionClosed, onBack, onChanged, onCreated, siblings, onOpenFeed, onRename, onFork, onExport }: {
  snippet: FeedSnippet;
  library: LibraryPaper[];
  collections: Array<{ id: string; name: string }>;
  models: FeedModelOption[];
  defaultModelLabel: string;
  defaultEffort: EffortSetting;
  historySelectionRequest: { nonce: number; returnFocus: HTMLButtonElement | null } | null;
  onHistorySelectionClosed: () => void;
  onBack: () => void;
  onChanged: () => void;
  onCreated: (id: string) => void;
  /** The same whole-feed actions the sidebar row offers, reused by the composer's
   *  commands so there is one implementation of each. */
  /** Every feed, so a compaction link can name and reach its counterpart. */
  siblings: FeedSnippet[];
  onOpenFeed: (id: string) => void;
  onRename: (title?: string) => Promise<void>;
  onFork: () => Promise<void>;
  onExport: () => Promise<void>;
}) {
  const feedName = snippet.title || snippet.instruction || "Untitled";
  const [messages, setMessages] = useState<FeedMessage[]>([]);
  const [proposalBlockOpen, setProposalBlockOpen] = useState<Record<string, boolean>>({});
  const [proposals, setProposals] = useState<FeedProposal[]>([]);
  const [replying, setReplying] = useState(false);
  // The turn a retry or rewind is working on, the text a rewind recovered, and the
  // key that remounts the composer around that text.
  const [busyTurnId, setBusyTurnId] = useState<string | null>(null);
  const [forkingFromId, setForkingFromId] = useState<string | null>(null);
  const [restoredReply, setRestoredReply] = useState("");
  const [composerNonce, setComposerNonce] = useState(0);
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolvingAll, setResolvingAll] = useState<"approve" | "reject" | null>(null);
  // Which proposal card is expanded to its structured change details.
  const [expandedProposal, setExpandedProposal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);
  const [openingWorkingDirectory, setOpeningWorkingDirectory] = useState(false);
  const [streamNonce, setStreamNonce] = useState(0);
  const [selectingHistory, setSelectingHistory] = useState(false);
  const [selectedInteractions, setSelectedInteractions] = useState<Set<string>>(() => new Set());
  const [includeToolDetails, setIncludeToolDetails] = useState(false);
  const [creatingFromHistory, setCreatingFromHistory] = useState(false);
  const [historyReady, setHistoryReady] = useState(false);
  const [visibleInteractionCount, setVisibleInteractionCount] = useState(FEED_HISTORY_WINDOW);
  const [visibleInteractionStart, setVisibleInteractionStart] = useState<number | null>(null);
  const running = snippet.status === "running" || snippet.status === "queued";
  // Keep the stream effect's dependency array shape stable for Fast Refresh
  // while still reconnecting when an external action starts or ends a run.
  const streamVersion = `${streamNonce}:${running ? "running" : "idle"}`;
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyInnerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Stick-to-bottom: while pinned, every content change scrolls to the latest
  // message (a thread opens pinned, and a reply re-pins). History streams in
  // over several batches, so a one-shot scroll would strand the view partway;
  // instead the pin persists until the user scrolls up, and re-arms when they
  // return to the bottom.
  const pinnedToBottomRef = useRef(true);
  // Persist the opening pin until the SSE endpoint confirms that its persisted
  // history has been replayed. Without this guard, a scroll event caused by the
  // growing history can look like a user scroll and disable following halfway
  // through a long conversation.
  const replayingHistoryRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historySelectionRequestNonce = historySelectionRequest?.nonce ?? null;

  useEffect(() => {
    if (historySelectionRequestNonce !== null) setSelectingHistory(true);
  }, [historySelectionRequestNonce]);

  const scrollToBottom = useCallback(() => {
    const body = bodyRef.current;
    setVisibleInteractionStart(null);
    setVisibleInteractionCount(FEED_HISTORY_WINDOW);
    pinnedToBottomRef.current = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (body) body.scrollTop = body.scrollHeight;
      setAtBottom(true);
    }));
  }, []);

  /**
   * Follow the newest content while pinned to the bottom.
   *
   * A ResizeObserver rather than an effect on `messages`: streamed text grows the
   * LAST bubble without adding a message, so a dependency-driven effect only fired
   * once per message and the view lurched a paragraph at a time. Observing the
   * thread's height reacts to every token.
   *
   * The catch-up is eased per frame instead of assigning scrollTop (a jump) or
   * calling scrollTo({behavior:"smooth"}) (which restarts its animation on each
   * mutation and stalls). Moving a fraction of the remaining distance each frame
   * gives a continuous glide that naturally keeps pace with generation.
   */
  useEffect(() => {
    const body = bodyRef.current;
    const content = bodyInnerRef.current;
    if (!body || !content) return;
    let frame = 0;
    // Opening a thread lands at the bottom outright. Easing there would crawl down
    // the whole history of a long feed, and any growth from images or late-loading
    // content restarts the glide, so it never actually arrives.
    let settled = false;
    const follow = () => {
      frame = 0;
      if (!pinnedToBottomRef.current) return;
      const remaining = body.scrollHeight - body.scrollTop - body.clientHeight;
      if (remaining <= 1) return;
      if (!settled || replayingHistoryRef.current) {
        body.scrollTop = body.scrollHeight;
        return;
      }
      // Ease in, but always advance at least a pixel so slow growth still tracks
      // instead of creeping to a halt just short of the bottom.
      body.scrollTop += Math.max(1, remaining * 0.22);
      frame = requestAnimationFrame(follow);
    };
    const onGrow = () => {
      setAtBottom(body.scrollHeight - body.scrollTop - body.clientHeight < 120);
      if (pinnedToBottomRef.current && !frame) {
        frame = requestAnimationFrame(follow);
      }
    };
    const observer = new ResizeObserver(onGrow);
    // Observe the stable inner wrapper rather than whichever message children
    // happened to exist when this effect ran. Its size changes for appended
    // history, streamed prose, expanded details, images, and diagrams alike.
    observer.observe(content);
    onGrow();
    // Anything after the initial layout is streaming, which is what the easing is
    // for. Two frames: one for this paint, one for the height it settles at.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (pinnedToBottomRef.current) body.scrollTop = body.scrollHeight;
      settled = true;
    }));
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [snippet.id]);

  // Scroll position alone cannot identify user intent: browser anchoring and
  // late-rendering rich content also emit scroll events. Only unpin after an
  // actual wheel, touch, pointer, or navigation-key gesture; programmatic and
  // layout-driven movement keeps following the conversation.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const markUserScrollIntent = () => {
      userScrollIntentRef.current = true;
      if (userScrollIntentTimerRef.current) clearTimeout(userScrollIntentTimerRef.current);
      userScrollIntentTimerRef.current = setTimeout(() => {
        userScrollIntentRef.current = false;
        userScrollIntentTimerRef.current = null;
      }, 180);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        markUserScrollIntent();
      }
    };
    const onScroll = () => {
      const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
      if (nearBottom) pinnedToBottomRef.current = true;
      else if (!replayingHistoryRef.current && userScrollIntentRef.current) pinnedToBottomRef.current = false;
      setAtBottom(nearBottom);
    };
    onScroll();
    body.addEventListener("scroll", onScroll, { passive: true });
    body.addEventListener("wheel", markUserScrollIntent, { passive: true });
    body.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    body.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    body.addEventListener("keydown", onKeyDown);
    return () => {
      body.removeEventListener("scroll", onScroll);
      body.removeEventListener("wheel", markUserScrollIntent);
      body.removeEventListener("touchstart", markUserScrollIntent);
      body.removeEventListener("pointerdown", markUserScrollIntent);
      body.removeEventListener("keydown", onKeyDown);
      if (userScrollIntentTimerRef.current) clearTimeout(userScrollIntentTimerRef.current);
    };
  }, []);

  // Stream this snippet's events. The endpoint replays persisted history first,
  // then live events if it's still running, then closes. Re-run on a local reply
  // AND when an external action (such as GitHub sync) changes a finished thread
  // back to running. Without that state in `streamVersion`, the old EventSource
  // stayed closed: the pending dots appeared from the refreshed snippet status,
  // but the synced user turn and every new agent event remained invisible until
  // reload.
  useEffect(() => {
    replayingHistoryRef.current = true;
    const source = new EventSource(`/api/feed/snippets/${snippet.id}/events`);
    let replayComplete = false;
    let replayFrame = 0;
    let settleFrame = 0;
    const completeReplay = () => {
      if (replayComplete) return;
      replayComplete = true;
      replayFrame = requestAnimationFrame(() => {
        settleFrame = requestAnimationFrame(() => {
          const body = bodyRef.current;
          pinnedToBottomRef.current = true;
          if (body) body.scrollTop = body.scrollHeight;
          replayingHistoryRef.current = false;
          setHistoryReady(true);
          setAtBottom(true);
        });
      });
    };
    source.addEventListener("message", (event) => {
      const message = JSON.parse((event as MessageEvent).data) as FeedMessage;
      setMessages((current) => (current.some((m) => m.id === message.id) ? current : [...current, message]));
    });
    source.addEventListener("usage", (event) => {
      // Usage is known only when the turn ends, after its message was streamed, so
      // the running thread patches that message instead of waiting for a reload.
      const usage = JSON.parse((event as MessageEvent).data) as { messageId: string; inputTokens: number; outputTokens: number; durationMs: number };
      setMessages((current) => current.map((message) => (
        message.id === usage.messageId
          ? { ...message, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, durationMs: usage.durationMs }
          : message
      )));
    });
    source.addEventListener("snapshot", (event) => {
      const snapshot = JSON.parse((event as MessageEvent).data) as FeedSnapshot;
      setMessages(snapshot.messages);
      setProposals(snapshot.proposals);
    });
    source.addEventListener("proposal", (event) => {
      const proposal = JSON.parse((event as MessageEvent).data) as FeedProposal;
      setProposals((current) => (current.some((p) => p.id === proposal.id) ? current : [...current, proposal]));
    });
    // `status` follows the replay for a live run; `done` follows it for a
    // finished run. Either boundary lets the opening view settle at the actual
    // final message rather than the height of an early render batch.
    source.addEventListener("status", completeReplay);
    source.addEventListener("done", () => {
      completeReplay();
      source.close();
      onChanged();
    });
    source.addEventListener("error", completeReplay);
    return () => {
      source.close();
      if (replayFrame) cancelAnimationFrame(replayFrame);
      if (settleFrame) cancelAnimationFrame(settleFrame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snippet.id, streamVersion]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/feed/snippets/${encodeURIComponent(snippet.id)}/working-directory`, { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ path?: string }> : null)
      .then((payload) => {
        if (!cancelled && payload?.path) setWorkingDirectory(payload.path);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [snippet.id]);

  async function sendReply(payload: AttachSubmit): Promise<boolean> {
    setReplying(true);
    setError(null);
    try {
      let response: Response;
      if (payload.files.length || payload.paperIds.length) {
        const form = new FormData();
        form.set("reply", payload.text);
        form.set("model", payload.model);
        form.set("effort", payload.effort);
        form.set("effort", payload.effort);
        for (const file of payload.files) form.append("files", file);
        for (const paperId of payload.paperIds) form.append("paperIds", paperId);
        response = await fetch(`/api/feed/snippets/${snippet.id}/reply`, { method: "POST", body: form });
      } else {
        response = await fetch(`/api/feed/snippets/${snippet.id}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reply: payload.text, model: payload.model, effort: payload.effort }),
        });
      }
      if (response.ok) {
        // Re-pin the view to the bottom so the new turn (and the incoming
        // response) stays in view even if the user had scrolled up.
        pinnedToBottomRef.current = true;
        setVisibleInteractionStart(null);
        setVisibleInteractionCount(FEED_HISTORY_WINDOW);
        setStreamNonce((nonce) => nonce + 1);
        onChanged();
        return true;
      }
      setError(await readError(response));
      return false;
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Reply failed.");
      return false;
    } finally {
      setReplying(false);
    }
  }

  async function stop() {
    await fetch(`/api/feed/snippets/${snippet.id}/stop`, { method: "POST" });
  }

  /**
   * Compact this thread into a new feed and open it. This thread is left as it is, so
   * the whole conversation stays readable; the new one starts from the summary and is
   * linked back to this. Anything typed in the composer becomes the compaction's focus
   * text and is then cleared, since it was consumed rather than sent.
   */
  async function compactSession(instructions: string): Promise<boolean> {
    setError(null);
    try {
      const response = await fetch(`/api/feed/snippets/${snippet.id}/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(instructions ? { instructions } : {}),
      });
      if (!response.ok) {
        setError(await readError(response));
        return false;
      }
      const payload = await response.json().catch(() => null) as { id?: string } | null;
      setStreamNonce((nonce) => nonce + 1);
      if (payload?.id) onCreated(payload.id);
      else onChanged();
      return true;
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "The session could not be compacted.");
      return false;
    }
  }

  async function openWorkingDirectory() {
    setOpeningWorkingDirectory(true);
    setError(null);
    try {
      const response = await fetch(`/api/feed/snippets/${encodeURIComponent(snippet.id)}/working-directory`, {
        method: "POST",
      });
      if (!response.ok) {
        setError(await readError(response));
      } else {
        const payload = await response.json().catch(() => null) as { path?: string } | null;
        if (payload?.path) setWorkingDirectory(payload.path);
      }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "The working directory could not be opened.");
    } finally {
      setOpeningWorkingDirectory(false);
    }
  }

  // Resolve one proposal and fold the outcome into local state. Returns whether
  // the server applied it, so the bulk path can refresh once at the end.
  async function postResolution(proposalId: string, decision: "approve" | "reject"): Promise<boolean> {
    const response = await fetch(`/api/feed/proposals/${proposalId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const payload = await response.json().catch(() => ({})) as { status?: string; error?: string };
    const nextStatus = response.ok ? (payload.status ?? decision) : "failed";
    setProposals((current) => current.map((proposal) =>
      proposal.id === proposalId
        ? { ...proposal, status: nextStatus, summary: payload.error ? `${proposal.summary}: ${payload.error}` : proposal.summary }
        : proposal,
    ));
    return response.ok;
  }

  async function resolveProposal(proposalId: string, decision: "approve" | "reject") {
    setResolving(proposalId);
    try {
      // Refresh the snippet list so the sidebar's pending-proposal badge (computed
      // server-side) reflects the resolved proposal instead of a stale count.
      if (await postResolution(proposalId, decision)) onChanged();
    } finally {
      setResolving(null);
    }
  }

  // Resolve every currently-pending proposal one at a time, in list order, so a
  // "create collection" applies before the papers that join it. A single failure
  // is recorded on its card and does not abort the rest.
  async function resolveAll(decision: "approve" | "reject") {
    const pending = proposals.filter((proposal) => proposal.status === "pending");
    if (!pending.length) return;
    setResolvingAll(decision);
    try {
      let applied = false;
      for (const proposal of pending) {
        if (await postResolution(proposal.id, decision)) applied = true;
      }
      if (applied) onChanged();
    } finally {
      setResolvingAll(null);
    }
  }

  const pendingCount = proposals.filter((p) => p.status === "pending").length;
  const hasStoredError = messages.some((message) => message.kind === "error");
  const interactions = useMemo(
    () => groupFeedInteractions(snippet.instruction, snippet.attachments, messages),
    [messages, snippet.attachments, snippet.instruction],
  );
  const visibleStart = visibleInteractionStart ?? Math.max(0, interactions.length - visibleInteractionCount);
  const visibleInteractions = useMemo(
    () => interactions.slice(visibleStart, visibleStart + visibleInteractionCount),
    [interactions, visibleInteractionCount, visibleStart],
  );
  const visibleMessages = useMemo(
    () => visibleInteractions.flatMap((interaction) => interaction.messages),
    [visibleInteractions],
  );
  const hiddenInteractionCount = visibleStart;
  const hiddenLaterInteractionCount = Math.max(0, interactions.length - visibleStart - visibleInteractions.length);
  const openingInteractionVisible = visibleInteractions.some((interaction) => interaction.opening);

  function toggleInteraction(id: string) {
    setSelectedInteractions((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function cancelHistorySelection() {
    if (creatingFromHistory) return;
    setSelectingHistory(false);
    setSelectedInteractions(new Set());
    setIncludeToolDetails(false);
    onHistorySelectionClosed();
  }

  function showEarlierInteractions() {
    const body = bodyRef.current;
    const previousHeight = body?.scrollHeight ?? 0;
    const added = Math.min(FEED_HISTORY_WINDOW, hiddenInteractionCount);
    if (visibleInteractionStart !== null) setVisibleInteractionStart(Math.max(0, visibleStart - added));
    setVisibleInteractionCount((current) => Math.min(interactions.length, current + added));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (body) body.scrollTop += body.scrollHeight - previousHeight;
    }));
  }

  function setVisibleInteractions(ids: string[], shouldSelect: boolean) {
    setSelectedInteractions((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (shouldSelect) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function jumpToInteraction(id: string) {
    const index = interactions.findIndex((interaction) => interaction.id === id);
    if (index !== -1) {
      const centeredStart = Math.max(0, Math.min(
        index - Math.floor(FEED_HISTORY_WINDOW / 2),
        interactions.length - FEED_HISTORY_WINDOW,
      ));
      setVisibleInteractionStart(centeredStart);
      setVisibleInteractionCount(FEED_HISTORY_WINDOW);
    }
    cancelHistorySelection();
    pinnedToBottomRef.current = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-interaction-id]") ?? [])]
        .find((element) => element.dataset.interactionId === id);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
    }));
  }

  /**
   * Copy a selection of this thread's interactions into a new feed. The selection
   * modal passes what the user ticked; a turn's own Fork passes everything before
   * it, which is the same history its Rewind would keep.
   */
  async function createForkFromHistory(interactionIds: string[], toolDetails: boolean) {
    if (!interactionIds.length || creatingFromHistory) return;
    setCreatingFromHistory(true);
    setError(null);
    try {
      const response = await fetch(`/api/feed/snippets/${snippet.id}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interactionIds, includeToolDetails: toolDetails }),
      });
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      const payload = await response.json() as { id: string };
      onHistorySelectionClosed();
      onCreated(payload.id);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "The new feed could not be created.");
    } finally {
      setCreatingFromHistory(false);
    }
  }

  /**
   * Ask one of the turns again: its question stays, and what it produced (plus every
   * turn after it) is replaced by a new attempt. This is the way back from a turn
   * that was interrupted or failed, where only the answer is missing. Confirmed only
   * when later turns would go with it, since retrying the last turn discards nothing
   * the user has not already seen fail.
   */
  async function retryTurn(interactionId: string) {
    const later = interactions.length - interactionsBefore(interactions, interactionId).length - 1;
    if (later > 0 && !window.confirm(`Ask this turn again? Its answer and the ${later} turn${later === 1 ? "" : "s"} after it are removed. This cannot be undone.`)) {
      return;
    }
    setBusyTurnId(interactionId);
    setError(null);
    try {
      const response = await fetch(`/api/feed/snippets/${snippet.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interactionId }),
      });
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      setStreamNonce((nonce) => nonce + 1);
      onChanged();
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "The turn could not be retried.");
    } finally {
      setBusyTurnId(null);
    }
  }

  /** Continue from before one of the user's turns in a new feed, leaving this one
   *  as it is: the copy holds the history a rewind to that point would keep. */
  async function forkBefore(message: FeedMessage) {
    setForkingFromId(message.id);
    try {
      // The same tool-detail choice the selection modal offers, so one setting
      // governs how much history any copy of this thread carries.
      await createForkFromHistory(interactionsBefore(interactions, message.id), includeToolDetails);
    } finally {
      setForkingFromId(null);
    }
  }

  /**
   * Take the thread back to just before one of the user's turns: that interaction
   * and every later one are removed, and its text returns to the composer so it can
   * be asked differently. Irreversible, hence the confirmation. Forking the same
   * point keeps this thread and continues in a copy instead.
   */
  async function rewindTo(message: FeedMessage) {
    // Counted in turns, not rows: a single turn can hold dozens of tool messages,
    // and the thread shows those collapsed rather than as messages of their own.
    const later = interactions.length - interactionsBefore(interactions, message.id).length - 1;
    const scope = later > 0 ? `this turn and the ${later} after it` : "this turn";
    if (!window.confirm(`Rewind to before this message? Stacks removes ${scope} from this thread and puts the text back in the reply box. This cannot be undone.`)) {
      return;
    }
    setBusyTurnId(message.id);
    setError(null);
    try {
      const response = await fetch(`/api/feed/snippets/${snippet.id}/rewind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interactionId: message.id }),
      });
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      const payload = await response.json().catch(() => null) as { reply?: string } | null;
      // A fresh composer carrying the recovered text: remounting is what clears
      // the previous one's staged files, which belonged to the turn just removed.
      setRestoredReply(payload?.reply ?? "");
      setComposerNonce((nonce) => nonce + 1);
      setStreamNonce((nonce) => nonce + 1);
      onChanged();
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "The thread could not be rewound.");
    } finally {
      setBusyTurnId(null);
    }
  }

  // A stored id says nothing about which record a change would hit, so name it from
  // the snapshot the composer already loads, and keep the id as secondary text.
  // Both directions of a compaction: where this thread came from, and where it was
  // carried on. Read off the list the sidebar already has rather than asked for.
  const compactionLinks = [
    ...(snippet.compactedFromId && siblings.some((feed) => feed.id === snippet.compactedFromId)
      ? [{ id: snippet.compactedFromId, label: "Compacted from" }]
      : []),
    ...siblings
      .filter((feed) => feed.compactedFromId === snippet.id)
      .map((feed) => ({ id: feed.id, label: "Continued in" })),
  ];

  const threadCommands: FeedCommand[] = [
    {
      name: "compact",
      argument: "[what to keep]",
      hint: "Continue in a new feed from a summary of this one",
      run: compactSession,
    },
    ...(running
      ? [{
        name: "stop",
        hint: "Stop the current turn",
        run: async () => { await stop(); return true; },
      }]
      : []),
    {
      name: "fork",
      hint: "Continue in a copy of this thread",
      run: async () => { await onFork(); return true; },
    },
    {
      name: "rename",
      argument: "<new title>",
      hint: "Retitle this feed",
      run: async (title) => { await onRename(title || undefined); return true; },
    },
    {
      name: "export",
      hint: "Download as Markdown",
      run: async () => { await onExport(); return true; },
    },
  ];

  const papersById = new Map(library.map((paper) => [paper.id, paper]));
  const collectionsById = new Map(collections.map((collection) => [collection.id, collection]));
  function describeProposalTarget(id: string): { label: string; meta?: string } {
    const paper = papersById.get(id);
    if (paper) {
      const meta = [paper.venueAcronym || paper.venueName, paper.year].filter(Boolean).join(" · ");
      return { label: paper.title, meta: meta ? `${meta} · ${id}` : id };
    }
    const collection = collectionsById.get(id);
    if (collection) return { label: collection.name, meta: id };
    return { label: id };
  }

  // Anchor each proposal to the assistant message that produced it, so it renders
  // inline in the thread instead of always pinned to the bottom. Only assistant
  // text/result messages render proposals inline; tool_use, tool_result, and
  // error messages return early in the loop below and never reach the anchor
  // check. A proposal anchored to one of those (or to no/an unknown message)
  // falls back to the trailing block, or it would vanish entirely.
  const inlineAnchorIds = new Set(
    messages.filter((message) => message.role === "assistant" && (message.kind === "text" || message.kind === "result")).map((message) => message.id),
  );
  const proposalsByMessage = new Map<string, FeedProposal[]>();
  for (const proposal of proposals) {
    if (!proposal.messageId || !inlineAnchorIds.has(proposal.messageId)) continue;
    const group = proposalsByMessage.get(proposal.messageId) ?? [];
    group.push(proposal);
    proposalsByMessage.set(proposal.messageId, group);
  }
  // Everything else takes its place in the thread by time, not at the end. A
  // proposal the agent posted through the API is anchored to a tool_use message,
  // which renders inside a collapsed tool group rather than as a turn, so it used
  // to sink to a trailing block: an older resolved change then sat below newer
  // pending ones and the thread read out of order.
  const floatingProposals = proposals
    .filter((proposal) => !proposal.messageId || !inlineAnchorIds.has(proposal.messageId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  function renderProposals(list: FeedProposal[], key: string): ReactNode {
    if (!list.length) return null;
    const pendingHere = list.filter((proposal) => proposal.status === "pending").length;
    const busy = resolvingAll !== null || resolving !== null;
    return (
      // Open while anything still needs a decision, foldable once resolved: a long
      // thread accumulates decided blocks that no longer need to be read. The state
      // is held here because the thread re-renders on every poll and stream event,
      // which would otherwise snap a block the reader just opened back shut.
      <details
        className="feed-proposals"
        key={key}
        open={proposalBlockOpen[key] ?? pendingHere > 0}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setProposalBlockOpen((current) => (current[key] === open ? current : { ...current, [key]: open }));
        }}
      >
        <summary className="feed-proposals-head">
          <span className="feed-proposals-title"><Check size={13} /> Proposed library changes</span>
          <span className="feed-proposals-count">{pendingHere ? `${pendingHere} pending` : `${list.length} resolved`}</span>
        </summary>
        {pendingHere > 1 ? (
          <div className="feed-proposals-bulk">
            <ActionButton variant="secondary" size="small" disabled={busy} onClick={() => void resolveAll("reject")} icon={resolvingAll === "reject" ? <LoaderCircle className="spin" size={13} /> : <X size={13} />}>Reject all</ActionButton>
            <ActionButton variant="primary" size="small" disabled={busy} onClick={() => void resolveAll("approve")} icon={resolvingAll === "approve" ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}>Approve all</ActionButton>
          </div>
        ) : null}
        {list.map((proposal) => {
          const expanded = expandedProposal === proposal.id;
          return (
            <div key={proposal.id} className={`feed-proposal feed-proposal-${proposal.status} ${expanded ? "is-expanded" : ""}`}>
              <div className="feed-proposal-row">
                <button
                  type="button"
                  className="feed-proposal-body"
                  onClick={() => setExpandedProposal(expanded ? null : proposal.id)}
                  aria-expanded={expanded}
                >
                  {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span className="feed-proposal-summary-text">{proposal.summary}</span>
                  <span className="feed-proposal-meta">
                    {proposalTags(proposal.operation).map((tag) => (
                      <span key={tag.label} className={`feed-proposal-tag feed-proposal-tag-${tag.kind}`}>{tag.label}</span>
                    ))}
                    <span className={`feed-proposal-status feed-proposal-status-${proposal.status}`}>{proposal.status}</span>
                  </span>
                </button>
                {proposal.status === "pending" ? (
                  <div className="feed-proposal-actions">
                    <ActionButton variant="secondary" size="small" disabled={busy} onClick={() => void resolveProposal(proposal.id, "reject")} icon={<X size={13} />}>Reject</ActionButton>
                    <ActionButton variant="primary" size="small" disabled={busy} onClick={() => void resolveProposal(proposal.id, "approve")} icon={resolving === proposal.id ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}>Approve</ActionButton>
                  </div>
                ) : null}
              </div>
              {expanded ? <ProposalDetails operation={proposal.operation} feedId={snippet.id} feedName={feedName} describeTarget={describeProposalTarget} /> : null}
            </div>
          );
        })}
      </details>
    );
  }

  return (
    <section className="feed-detail">
      <header className="feed-detail-head feed-detail-thread-head">
        <div className="feed-detail-head-inner">
          <button type="button" className="feed-detail-back" onClick={onBack} aria-label="Back to list"><ArrowLeft size={16} /></button>
          <div className="feed-detail-heading">
            <h1>{snippet.title || snippet.instruction || "Untitled"}</h1>
            <div className="feed-detail-meta">
              <span className={`feed-status feed-status-${snippet.status}`}>
                <StatusGlyph status={snippet.status} size={12} />
                {statusLabel(snippet.status)}
              </span>
              {snippetStats(snippet).map((stat) => (
                <span key={stat} className="feed-detail-stat">{stat}</span>
              ))}
              <span className="feed-detail-stat feed-time-tip" tabIndex={0} data-tip={`Created ${fullTime(snippet.createdAt)}`}>Created {relativeTime(snippet.createdAt)}</span>
              <span className="feed-detail-stat feed-time-tip" tabIndex={0} data-tip={`Updated ${fullTime(snippet.updatedAt)}`}>Updated {relativeTime(snippet.updatedAt)}</span>
              {compactionLinks.map((link) => (
                <button
                  key={link.id}
                  type="button"
                  className="feed-detail-link"
                  onClick={() => onOpenFeed(link.id)}
                >
                  <FoldVertical size={12} aria-hidden="true" />
                  {link.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="feed-working-directory-link"
              disabled={openingWorkingDirectory}
              onClick={() => void openWorkingDirectory()}
              aria-label={workingDirectory ? `Open working directory ${workingDirectory}` : "Open feed working directory"}
              aria-busy={openingWorkingDirectory}
            >
              {openingWorkingDirectory ? <LoaderCircle className="spin" /> : <FolderOpen />}
              <code>{workingDirectory ?? "Loading working directory…"}</code>
            </button>
          </div>
          {pendingCount ? <span className="feed-detail-badge">{pendingCount} to approve</span> : null}
        </div>
      </header>

      <div className="feed-detail-body" ref={bodyRef}>
        <div className="feed-detail-body-inner" ref={bodyInnerRef}>
        {snippet.status === "error" && snippet.error && !hasStoredError ? (
          <div className="feed-error-banner">
            <FeedErrorMessage content={snippet.error} />
          </div>
        ) : null}
        {!historyReady ? (
          <div className="feed-thread-loading" role="status">
            <LoaderCircle className="spin" size={18} />
            <span>Loading conversation history…</span>
          </div>
        ) : null}
        {historyReady && hiddenInteractionCount ? (
          <div className="feed-history-window-control">
            <ActionButton variant="secondary" size="small" onClick={showEarlierInteractions} icon={<ChevronUp size={14} />}>
              Show {Math.min(FEED_HISTORY_WINDOW, hiddenInteractionCount)} earlier interaction{Math.min(FEED_HISTORY_WINDOW, hiddenInteractionCount) === 1 ? "" : "s"}
            </ActionButton>
          </div>
        ) : null}
        {(() => {
          if (!historyReady || !openingInteractionVisible) return null;
          const openingAttachments = parseAttachments(snippet.attachments);
          // The opening "You" turn shows the instruction the user typed plus any
          // attachments. Render the instruction bubble whenever it exists — it is
          // the turn's content, distinct from the header title (which may be an
          // identical, truncated copy). Suppressing it when it equaled the title
          // dropped the user's query from the thread when a paper was attached.
          const openingText = snippet.instruction?.trim() ?? "";
          if (!openingText && openingAttachments.length === 0) return null;
          return (
            <div className="feed-message feed-turn feed-turn-user" data-interaction-id={OPENING_INTERACTION_ID}>
              <span className="feed-turn-label">You</span>
              {openingText ? <MarkdownContent content={openingText} className="feed-bubble" enableFeedRichContent feedId={snippet.id} feedName={feedName} /> : null}
              <AttachmentChips snippetId={snippet.id} attachments={openingAttachments} />
              <TurnMeta
                iso={snippet.createdAt}
                onRetry={() => void retryTurn(OPENING_INTERACTION_ID)}
                busy={busyTurnId === OPENING_INTERACTION_ID}
              />
            </div>
          );
        })()}
        <div className="feed-thread">
          {(() => {
            if (!historyReady) return null;
            const nodes: ReactNode[] = [];
            const displayMessages = coalesceLegacyAgentErrors(visibleMessages);
            // Pair each tool_use with its result by tool_use id — the agent can
            // issue calls in parallel (use A, use B, result A, result B), so
            // position alone mispairs them. Results claimed by id are skipped
            // when the loop reaches them.
            const resultById = new Map<string, FeedMessage>();
            for (const message of displayMessages) {
              if (message.kind === "tool_result" && message.toolUseId) {
                resultById.set(message.toolUseId, message);
              }
            }
            const claimed = new Set<string>();
            let pendingToolOperations: FeedToolOperation[] = [];
            const addToolOperation = (operation: FeedToolOperation) => {
              pendingToolOperations.push(operation);
            };
            // Proposals with no rendered anchor are emitted in their own place in the
            // thread: everything created up to the message about to render, and the
            // remainder after the last one.
            let floatingIndex = 0;
            const flushFloatingProposals = (until: string | null) => {
              const due: FeedProposal[] = [];
              while (floatingIndex < floatingProposals.length) {
                const next = floatingProposals[floatingIndex];
                if (until !== null && next.createdAt.localeCompare(until) > 0) break;
                due.push(next);
                floatingIndex += 1;
              }
              if (due.length) nodes.push(renderProposals(due, `props-floating-${due[0].id}`));
            };
            const flushToolOperations = () => {
              if (!pendingToolOperations.length) return;
              if (pendingToolOperations.length === 1) {
                const operation = pendingToolOperations[0];
                nodes.push(<FeedToolCall key={operation.id} operation={operation} feedId={snippet.id} feedName={feedName} />);
              } else {
                const operations = pendingToolOperations;
                nodes.push(
                  <FeedToolGroup key={`tool-group-${operations[0].id}`} operations={operations} feedId={snippet.id} feedName={feedName} />,
                );
              }
              pendingToolOperations = [];
            };
            for (let i = 0; i < displayMessages.length; i += 1) {
              const message = displayMessages[i];
              if (message.kind === "tool_use") {
                let resultMessage: FeedMessage | null = null;
                if (message.toolUseId && resultById.has(message.toolUseId)) {
                  resultMessage = resultById.get(message.toolUseId) ?? null;
                  if (resultMessage) claimed.add(resultMessage.id);
                } else {
                  // Legacy rows without ids: fall back to the adjacent result.
                  const next = displayMessages[i + 1];
                  if (next && next.kind === "tool_result" && !next.toolUseId) {
                    resultMessage = next;
                    claimed.add(next.id);
                  }
                }
                const space = message.content.indexOf(" ");
                const toolName = space === -1 ? message.content : message.content.slice(0, space);
                const toolInput = space === -1 ? "" : message.content.slice(space + 1);
                addToolOperation({
                  id: message.id,
                  label: toolName,
                  input: toolInput,
                  result: resultMessage?.content,
                });
                continue;
              }
              if (message.kind === "tool_result") {
                // Skip results already shown inside their matching tool_use.
                if (claimed.has(message.id)) {
                  continue;
                }
                addToolOperation({ id: message.id, label: "tool result", result: message.content });
                continue;
              }
              flushToolOperations();
              flushFloatingProposals(message.createdAt);
              if (message.kind === "error") {
                nodes.push(
                  <div key={message.id} className="feed-message feed-message-error">
                    <FeedErrorMessage content={message.content} />
                  </div>,
                );
                continue;
              }
              // System notices (e.g. a model switch) render as a subtle centered line.
              if (message.role === "system") {
                nodes.push(
                  <div key={message.id} className="feed-message feed-system-note">{message.content}</div>,
                );
                continue;
              }
              const { prose: rawProse, raw } = message.role === "user" ? { prose: message.content, raw: null } : splitProposalBlock(message.content);
              const messageAttachments = message.role === "user" ? parseAttachments(message.attachments) : [];
              // Drop the "(attached N files)" placeholder when the chips convey it.
              const prose = messageAttachments.length && /^\(attached \d+ files?\)$/.test(rawProse.trim()) ? "" : rawProse;
              if (prose || messageAttachments.length) {
                nodes.push(
                  <div key={message.id} className={`feed-message feed-turn feed-turn-${message.role}`} data-interaction-id={message.role === "user" ? message.id : undefined}>
                    <span className="feed-turn-label">{message.role === "user" ? "You" : "Agent"}</span>
                    {prose ? <MarkdownContent content={prose} className="feed-bubble" enableFeedRichContent feedId={snippet.id} feedName={feedName} /> : null}
                    <AttachmentChips snippetId={snippet.id} attachments={messageAttachments} />
                    <TurnMeta
                      iso={message.createdAt}
                      message={message}
                      onRetry={message.role === "user" ? () => void retryTurn(message.id) : undefined}
                      onFork={message.role === "user" ? () => void forkBefore(message) : undefined}
                      onRewind={message.role === "user" ? () => void rewindTo(message) : undefined}
                      busy={busyTurnId === message.id || (creatingFromHistory && forkingFromId === message.id)}
                    />
                  </div>,
                );
              }
              // The proposal cards below carry the structured details (and raw
              // JSON) per change, so the block is only dumped as-is when no
              // cards were parsed out of it (e.g. a malformed agent block).
              const anchored = proposalsByMessage.get(message.id);
              if (raw && !anchored) {
                nodes.push(
                  <details key={`${message.id}-raw`} className="feed-tool-call feed-proposal-raw">
                    <summary><Code2 size={12} /> <span>Proposed changes (raw)</span></summary>
                    <div className="feed-tool-io"><span className="feed-tool-tag">JSON</span>{renderToolContent(raw, snippet.id, feedName)}</div>
                  </details>,
                );
              }
              if (anchored) {
                nodes.push(renderProposals(anchored, `props-${message.id}`));
              }
            }
            flushToolOperations();
            flushFloatingProposals(null);
            return nodes;
          })()}
          {historyReady && running ? (
            // Dots only: an agent turn is bare prose, so wrapping them in a bubble
            // would make the pending turn look unlike the reply that replaces it.
            <div className="feed-message feed-turn feed-turn-assistant feed-turn-pending">
              <span className="feed-turn-label">Agent</span>
              <span className="typing feed-typing" role="status" aria-label="The agent is working"><i /><i /><i /></span>
            </div>
          ) : null}
        </div>

        {error ? <div className="feed-error-banner"><FeedErrorMessage content={error} announce /></div> : null}
        </div>
      </div>

      <footer className="feed-detail-foot">
        {!atBottom || hiddenLaterInteractionCount ? (
          <button type="button" className="feed-scroll-bottom" onClick={scrollToBottom} aria-label="Scroll to latest">
            <ArrowDown size={16} />
          </button>
        ) : null}
        <AttachBox
          key={composerNonce}
          library={library}
          models={models}
          initialText={restoredReply}
          initialModel={snippet.model ?? ""}
          initialEffort={snippet.effort ?? ""}
          defaultModelLabel={defaultModelLabel}
          defaultEffortLabel={defaultEffort}
          placeholder={running ? "Message the agent…" : "Reply to the agent…"}
          submitLabel={running ? "Interrupt & send" : "Reply"}
          submitting={replying}
          compact
          hint={<><kbd>⌥↵</kbd> newline</>}
          onSubmit={sendReply}
          commands={threadCommands}
          leadingAction={running ? (
            // Labelled and in the danger colour: a bare grey square beside the
            // attachment icons read as an empty checkbox rather than a stop control.
            <ActionButton type="button" variant="danger" size="small" onClick={() => void stop()} icon={<Square size={13} />} aria-label="Stop the agent">Stop</ActionButton>
          ) : undefined}
        />
      </footer>
      {selectingHistory ? createPortal(
        <FeedHistorySelectionModal
          feedName={feedName}
          interactions={interactions}
          selected={selectedInteractions}
          includeToolDetails={includeToolDetails}
          creating={creatingFromHistory}
          loading={!historyReady}
          error={error}
          returnFocus={historySelectionRequest?.returnFocus ?? null}
          onToggle={toggleInteraction}
          onSetVisible={setVisibleInteractions}
          onIncludeToolDetails={setIncludeToolDetails}
          onClose={cancelHistorySelection}
          onCreate={() => void createForkFromHistory([...selectedInteractions], includeToolDetails)}
          onJump={jumpToInteraction}
        />,
        document.body,
      ) : null}
    </section>
  );
}

const FEED_SIDEBAR_KEY = "stacks-feed-sidebar-width";
const FEED_SIDEBAR_MIN = 240;
const FEED_SIDEBAR_MAX = 520;

export default function FeedWorkspace() {
  const [ready, setReady] = useState(false);
  const [snippets, setSnippets] = useState<FeedSnippet[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [historySelectionRequest, setHistorySelectionRequest] = useState<{ id: string; nonce: number; returnFocus: HTMLButtonElement | null } | null>(null);
  const [composing, setComposing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [libraryName, setLibraryName] = useState("My Paper Library");
  const [query, setQuery] = useState("");

  // Restore the persisted (draggable) sidebar width.
  useEffect(() => {
    const saved = Number(window.localStorage.getItem(FEED_SIDEBAR_KEY));
    if (saved >= FEED_SIDEBAR_MIN && saved <= FEED_SIDEBAR_MAX) setSidebarWidth(saved);
  }, []);

  // The shared handler owns the listener lifecycle: it matches the pointer id,
  // coalesces moves into a frame, and releases on cancel, blur, or a button let
  // go outside the window, none of which this used to survive.
  function startSidebarResize(event: React.PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    beginPointerResize(
      event.pointerId,
      (clientX) => setSidebarWidth(Math.min(FEED_SIDEBAR_MAX, Math.max(FEED_SIDEBAR_MIN, startWidth + clientX - startX))),
      () => setSidebarWidth((width) => { window.localStorage.setItem(FEED_SIDEBAR_KEY, String(width)); return width; }),
    );
  }
  const [library, setLibrary] = useState<LibraryPaper[]>([]);
  const [collections, setCollections] = useState<Array<{ id: string; name: string }>>([]);
  const [models, setModels] = useState<FeedModelOption[]>([]);
  const [defaultModelId, setDefaultModelId] = useState("");
  const [defaultEffort, setDefaultEffort] = useState<EffortSetting>("");
  const [skills, setSkills] = useState<FeedSkill[]>(DEFAULT_FEED_SKILLS);
  const [initialText, setInitialText] = useState("");
  const [initialPapers, setInitialPapers] = useState<LibraryPaper[]>([]);
  const [githubReady, setGithubReady] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  // The current failure stays visible until dismissed or a later sync succeeds;
  // the activity log below remains the durable history across reloads.
  const [syncAlert, setSyncAlert] = useState<{ summary: string; details: string } | null>(null);
  const [syncLog, setSyncLog] = useState<SyncLogEntry[]>([]);

  useEffect(() => { setSyncLog(readSyncLog()); }, []);

  const recordSync = useCallback((status: SyncLogEntry["status"], summary: string, details = "") => {
    setSyncLog((current) => {
      const next = [{ id: crypto.randomUUID(), at: Date.now(), status, summary, details: details || undefined }, ...current].slice(0, 50);
      writeSyncLog(next);
      return next;
    });
  }, []);
  const clearSyncLog = useCallback(() => { setSyncLog([]); writeSyncLog([]); }, []);

  // The configured default model's friendly label (falls back to the raw id).
  const defaultModelLabel = defaultModelId
    ? models.find((option) => option.id === defaultModelId)?.label ?? defaultModelId
    : "";

  // ⌘ on macOS, Ctrl elsewhere. Set after mount so SSR and client agree.
  const [modKey, setModKey] = useState("⌃");
  useEffect(() => {
    setModKey(/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? "⌘" : "⌃");
  }, []);

  // Collapse toggles that haven't been confirmed by the server yet. The 4s poll
  // reloads the whole list, so without this a poll firing mid-PATCH would revert
  // an optimistic collapse; loadSnippets re-applies these until the row's server
  // value matches (then the entry is cleared).
  const pendingCollapse = useRef<Map<string, boolean>>(new Map());

  const loadSnippets = useCallback(async () => {
    const response = await fetch("/api/feed/snippets", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json() as { snippets: FeedSnippet[] };
      const pending = pendingCollapse.current;
      const merged = data.snippets.map((snippet) => {
        if (!pending.has(snippet.id)) return snippet;
        const want = pending.get(snippet.id);
        // Server has caught up to the desired value → drop the override.
        if (Boolean(snippet.collapsed) === want) { pending.delete(snippet.id); return snippet; }
        return { ...snippet, collapsed: want };
      });
      setSnippets(merged);
    }
  }, []);

  // Read the authoritative settings: the library name, whether GitHub inbox
  // sync is configured (repo + token), and the configured default model id
  // (Settings → AI model) so the composer's picker can name the default.
  //
  // Re-read whenever this tab is shown again, not only on mount. Settings live on
  // another page (often another tab), so a mount-once read left the composer
  // naming the model that was configured when the feed was first opened: changing
  // the default in Settings appeared not to take effect here until a full reload.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetch("/api/local-settings", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { libraryName?: string; ai?: { modelId?: string; effort?: string }; github?: { repo?: string; connected?: boolean } } | null) => {
          if (cancelled || !data) return;
          if (data.libraryName?.trim()) setLibraryName(data.libraryName.trim());
          const configuredModel = data.ai?.modelId?.trim() ?? "";
          setDefaultModelId(isClaudeAgentModel(configuredModel) ? configuredModel : "");
          setDefaultEffort(effortSetting(data.ai?.effort));
          setGithubReady(Boolean(data.github?.repo && data.github.connected));
        })
        .catch(() => {});
    };
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    load();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", load);
    };
  }, []);

  const syncGithub = useCallback(async () => {
    setSyncing(true);
    setSyncProgress(0);
    try {
      const totals: Record<string, number> = {};
      let totalMutations = 0;
      let truncated = false;
      let pausedForMs = 0;

      // GitHub has no bulk Issues endpoint. The server therefore checkpoints a
      // small serial write batch and asks for another pass. Continue those
      // passes here so one Sync action can drain a large feed backlog safely.
      while (true) {
        const response = await fetch("/api/feed/github/sync", { method: "POST" });
        if (!response.ok) {
          const failure = await readErrorInfo(response);
          setSyncAlert(failure);
          recordSync("error", failure.summary, failure.details);
          return;
        }
        // Read the body defensively: a stale/misrouted server can answer with an
        // HTML error page, which would otherwise blow up JSON.parse with a cryptic
        // "Unexpected token '<'" instead of a legible failure.
        const data = (await response.json().catch(() => ({}))) as {
          counts?: Record<string, number>;
          truncated?: boolean;
          pending?: boolean;
          pauseReason?: "batch" | "cooldown";
          retryAfterMs?: number;
          mutations?: number;
        };
        for (const [key, value] of Object.entries(data.counts ?? {})) {
          totals[key] = (totals[key] ?? 0) + (Number.isFinite(value) ? value : 0);
        }
        totalMutations += typeof data.mutations === "number" && Number.isFinite(data.mutations) ? data.mutations : 0;
        setSyncProgress(totalMutations);
        truncated ||= Boolean(data.truncated);
        if (!data.pending) break;
        if (data.pauseReason === "cooldown") {
          pausedForMs = Math.max(1_000, data.retryAfterMs ?? 60_000);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, data.retryAfterMs ?? 1_000)));
      }

      const c = totals;
      const parts = [
        c.issuesCreated ? `${c.issuesCreated} issue${c.issuesCreated === 1 ? "" : "s"} created` : "",
        c.commentsPosted ? `${c.commentsPosted} posted` : "",
        c.feedsCreated ? `${c.feedsCreated} new feed${c.feedsCreated === 1 ? "" : "s"}` : "",
        c.commentsIngested ? `${c.commentsIngested} pulled` : "",
        c.commentsUpdated ? `${c.commentsUpdated} edited` : "",
        c.titlesRenamed ? `${c.titlesRenamed} renamed` : "",
        c.attachmentsUploaded ? `${c.attachmentsUploaded} file${c.attachmentsUploaded === 1 ? "" : "s"} uploaded` : "",
        c.proposalsPosted ? `${c.proposalsPosted} change${c.proposalsPosted === 1 ? "" : "s"} posted` : "",
        c.proposalsUpdated ? `${c.proposalsUpdated} change status${c.proposalsUpdated === 1 ? "" : "es"} updated` : "",
        c.feedsUnlinked ? `${c.feedsUnlinked} feed${c.feedsUnlinked === 1 ? "" : "s"} relinked to the new repo` : "",
      ].filter(Boolean);
      const base = parts.length
        ? `Synced: ${parts.join(", ")}`
        : pausedForMs ? "No items were sent in this pass" : "Synced, already up to date";
      setSyncAlert(null);
      if (pausedForMs) {
        recordSync("paused", `${base}. More items remain; sync again in ${formatDuration(pausedForMs)}.`);
      } else {
        recordSync("success", truncated ? `${base} (more remain, sync again)` : base);
      }
      await loadSnippets();
    } catch (error) {
      const details = error instanceof Error ? error.message : "No diagnostic information was returned.";
      const summary = "Unable to reach the GitHub sync service.";
      setSyncAlert({ summary, details });
      recordSync("error", summary, details);
    } finally {
      setSyncing(false);
      setSyncProgress(0);
    }
  }, [loadSnippets, recordSync]);

  useEffect(() => {
    let cancelled = false;
    void loadSnippets().finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [loadSnippets]);

  // Deep-link: /feed?snippet=<id> opens straight to that thread (e.g. after
  // launching a workflow). Runs once the snippets have loaded.
  const openedSnippetParam = useRef(false);
  useEffect(() => {
    if (openedSnippetParam.current || !snippets.length) return;
    const wanted = new URLSearchParams(window.location.search).get("snippet");
    if (wanted && snippets.some((snippet) => snippet.id === wanted)) {
      setSelectedId(wanted);
      setComposing(false);
      openedSnippetParam.current = true;
    }
  }, [snippets]);

  // Load the library so papers can be attached (and the ?paper= param
  // pre-attaches one, opening straight into the composer). Reload on tab focus
  // so papers added on the main page are attachable without a manual refresh.
  useEffect(() => {
    let cancelled = false;
    let first = true;
    const load = () => {
      void fetch("/api/library", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { papers?: LibraryPaper[]; collections?: Array<{ id: string; name: string }> } | null) => {
          if (cancelled || !data?.papers) return;
          setLibrary(data.papers);
          setCollections(data.collections ?? []);
          if (!first) return;
          first = false;
          const params = new URLSearchParams(window.location.search);
          const paperId = params.get("paper");
          if (paperId) {
            const paper = data.papers.find((item) => item.id === paperId);
            if (paper) {
              setInitialPapers([paper]);
              setInitialText("Discuss this paper with me. Read the attached file first.");
              setComposing(true);
            }
          }
        })
        .catch(() => {});
    };
    load();
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Load the Bedrock model catalog (the same list Settings shows) so each feed
  // can pick the agent model instead of always running the most powerful one.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/models", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { models?: Array<{ id: string; label: string }> } | null) => {
        if (!cancelled && data?.models) {
          setModels(data.models.filter(({ id }) => isClaudeAgentModel(id)).map(({ id, label }) => ({ id, label })));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Load the pickable feed skills (user-editable in Settings → Feed skills).
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/feed/skills", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { skills?: FeedSkill[] } | null) => {
        if (!cancelled && data?.skills?.length) setSkills(data.skills);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Poll while anything is running so row statuses/summaries settle even when a
  // snippet isn't the selected one streaming its own events.
  useEffect(() => {
    if (!snippets.some((snippet) => snippet.status === "running" || snippet.status === "queued")) {
      return;
    }
    const timer = window.setInterval(() => void loadSnippets(), 4000);
    return () => window.clearInterval(timer);
  }, [snippets, loadSnippets]);

  // Command shortcuts: ⌘M (Ctrl+M) starts a new feed — ⌘N is avoided because the
  // browser owns it (new window) — and ⌘S (Ctrl+S) syncs the GitHub inbox. Both
  // use a modifier so they never interfere with typing (a bare key would be
  // captured by type-anywhere below).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "m") { event.preventDefault(); setComposing(true); setSelectedId(null); }
      else if (key === "s" && githubReady && !syncing) { event.preventDefault(); void syncGithub(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [githubReady, syncing, syncGithub]);

  // Type-anywhere: a printable keypress with no field focused jumps into the
  // visible composer/reply textarea so you can just start typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1) return; // ignore Enter, arrows, etc.
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;
      const textarea = document.querySelector<HTMLTextAreaElement>(".feed-detail-foot .feed-dock textarea, .feed-compose .feed-dock textarea");
      if (textarea) textarea.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selected = useMemo(
    () => snippets.find((snippet) => snippet.id === selectedId) ?? null,
    [snippets, selectedId],
  );

  useEffect(() => {
    const title = selected
      ? selected.title || selected.instruction || "Untitled"
      : composing ? "New feed" : "AI feed";
    document.title = `${title} · Stacks`;
    return () => { document.title = "AI feed · Stacks"; };
  }, [composing, selected]);

  const filteredSnippets = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return snippets;
    return snippets.filter((snippet) => `${snippet.title} ${snippet.instruction}`.toLowerCase().includes(term));
  }, [snippets, query]);

  // Split the list: active feeds up top, collapsed ones tucked into their own
  // section at the bottom (still searchable).
  const activeSnippets = useMemo(() => filteredSnippets.filter((snippet) => !snippet.collapsed), [filteredSnippets]);
  const collapsedSnippets = useMemo(() => filteredSnippets.filter((snippet) => snippet.collapsed), [filteredSnippets]);
  const [showCollapsed, setShowCollapsed] = useState(false);

  async function toggleCollapse(snippet: FeedSnippet) {
    const next = !snippet.collapsed;
    // Optimistic: flip locally and record the intent so a concurrent poll can't
    // revert it before the server confirms. The GitHub issue is closed/reopened
    // on the next sync (see the sync route), not inline.
    pendingCollapse.current.set(snippet.id, next);
    setSnippets((current) => current.map((item) => (item.id === snippet.id ? { ...item, collapsed: next } : item)));
    if (selectedId === snippet.id && next) setSelectedId(null);
    try {
      const response = await fetch(`/api/feed/snippets/${snippet.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collapsed: next }),
      });
      if (!response.ok) throw new Error("collapse failed");
    } catch {
      // Roll back the optimistic flip if the server rejected it.
      pendingCollapse.current.delete(snippet.id);
      setSnippets((current) => current.map((item) => (item.id === snippet.id ? { ...item, collapsed: snippet.collapsed } : item)));
    }
  }

  async function createSnippet(payload: AttachSubmit): Promise<boolean> {
    setSubmitting(true);
    try {
      let response: Response;
      if (payload.files.length || payload.paperIds.length) {
        const form = new FormData();
        form.set("instruction", payload.text);
        form.set("model", payload.model);
        for (const file of payload.files) form.append("files", file);
        for (const paperId of payload.paperIds) form.append("paperIds", paperId);
        response = await fetch("/api/feed/snippets", { method: "POST", body: form });
      } else {
        response = await fetch("/api/feed/snippets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: payload.text, model: payload.model, effort: payload.effort }),
        });
      }
      if (response.ok) {
        const { id } = await response.json() as { id: string };
        setInitialText("");
        setInitialPapers([]);
        setComposing(false);
        await loadSnippets();
        setSelectedId(id);
        return true;
      }
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function renameSnippet(snippet: FeedSnippet, title?: string) {
    // The command supplies the title on its line; the menu item asks for one.
    const next = (title ?? window.prompt("Rename this feed", snippet.title || snippet.instruction || "") ?? "").trim();
    if (!next || next === snippet.title) return;
    const response = await fetch(`/api/feed/snippets/${snippet.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next }),
    });
    if (response.ok) await loadSnippets();
  }

  async function forkSnippet(snippet: FeedSnippet) {
    const response = await fetch(`/api/feed/snippets/${snippet.id}/fork`, { method: "POST" });
    if (response.ok) {
      const { id } = await response.json() as { id: string };
      await loadSnippets();
      setComposing(false);
      setSelectedId(id);
    }
  }

  function selectSnippetHistory(snippet: FeedSnippet, returnFocus: HTMLButtonElement | null) {
    if (snippet.status === "running" || snippet.status === "queued") return;
    setComposing(false);
    setSelectedId(snippet.id);
    setHistorySelectionRequest((current) => ({ id: snippet.id, nonce: (current?.nonce ?? 0) + 1, returnFocus }));
  }

  async function deleteSnippet(snippet: FeedSnippet) {
    if (!window.confirm(`Delete "${snippet.title || snippet.instruction || "this feed"}"? This cannot be undone.`)) return;
    const response = await fetch(`/api/feed/snippets/${snippet.id}`, { method: "DELETE" });
    if (response.ok) {
      if (selectedId === snippet.id) setSelectedId(null);
      await loadSnippets();
    }
  }

  async function exportSnippet(snippet: FeedSnippet) {
    const response = await fetch(`/api/feed/snippets/${snippet.id}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json() as { snippet: FeedSnippet; messages: FeedMessage[] };
    const title = data.snippet.title || data.snippet.instruction || "feed";
    const markdown = feedMarkdown({
      title,
      instruction: data.snippet.instruction,
      messages: data.messages,
    });
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${title.replace(/[^\w.-]+/g, "_").slice(0, 80) || "feed"}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (!ready) {
    return <main className="chat-workspace-loading"><span className="assistant-orb"><Rss size={18} /></span><p>Opening your feed…</p></main>;
  }

  const showDetail = Boolean(selected) && !composing;
  return (
    <main className={`feed-page workspace-enter app-interaction-scope ${showDetail || composing ? "has-selection" : ""} ${showDetail ? "has-thread" : ""}`} style={{ ["--feed-sidebar-width" as string]: `${sidebarWidth}px` }}>
      <div className="feed-theme-toggle">
        <ThemeToggle />
      </div>
      <aside className="feed-list-pane">
        <header className="feed-list-head">
          <Link href="/" aria-label="Return to Stacks" className="brand"><Brand subtitle="AI feed" /></Link>
          <ActionButton variant="primary" size="small" onClick={() => { setHistorySelectionRequest(null); setComposing(true); setSelectedId(null); }} icon={<Plus size={14} />} kbd={`${modKey}M`}>New</ActionButton>
        </header>
        {snippets.length ? (
          <div className="feed-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search feeds…" aria-label="Search feeds" />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={14} /></button> : null}
          </div>
        ) : null}
        <div className="feed-list" role="list">
          {snippets.length === 0 ? (
            <p className="feed-list-empty">No feeds yet.</p>
          ) : filteredSnippets.length === 0 ? (
            <p className="feed-list-empty">No feeds match “{query}”.</p>
          ) : (
            <>
              {activeSnippets.map((snippet) => (
                <FeedRow
                  key={snippet.id}
                  snippet={snippet}
                  active={snippet.id === selectedId && !composing}
                  onSelect={() => { setHistorySelectionRequest(null); setComposing(false); setSelectedId(snippet.id); }}
                  onRename={() => void renameSnippet(snippet)}
                  onFork={() => void forkSnippet(snippet)}
                  onSelectHistory={(returnFocus) => selectSnippetHistory(snippet, returnFocus)}
                  onExport={() => void exportSnippet(snippet)}
                  onCollapse={() => void toggleCollapse(snippet)}
                  onDelete={() => void deleteSnippet(snippet)}
                />
              ))}
              {collapsedSnippets.length ? (
                <div className="feed-collapsed-group">
                  <button type="button" className="feed-collapsed-toggle" onClick={() => setShowCollapsed((open) => !open)} aria-expanded={showCollapsed}>
                    {showCollapsed ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    Collapsed feeds
                    <span className="feed-collapsed-count">{collapsedSnippets.length}</span>
                  </button>
                  {showCollapsed ? collapsedSnippets.map((snippet) => (
                    <FeedRow
                      key={snippet.id}
                      snippet={snippet}
                      active={snippet.id === selectedId && !composing}
                      onSelect={() => { setHistorySelectionRequest(null); setComposing(false); setSelectedId(snippet.id); }}
                      onRename={() => void renameSnippet(snippet)}
                      onFork={() => void forkSnippet(snippet)}
                      onSelectHistory={(returnFocus) => selectSnippetHistory(snippet, returnFocus)}
                      onExport={() => void exportSnippet(snippet)}
                      onCollapse={() => void toggleCollapse(snippet)}
                      onDelete={() => void deleteSnippet(snippet)}
                    />
                  )) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
        {githubReady ? (
          <div className="feed-sidebar-foot">
            <SyncActivityDock log={syncLog} onClear={clearSyncLog} />
            <div className="sync-card">
              <span>
                <strong>{libraryName}</strong>
                <small>{syncLog[0] ? `${syncLog[0].status === "success" ? "Synced" : syncLog[0].status === "paused" ? "Sync paused" : "Sync failed"} ${relativeTime(new Date(syncLog[0].at).toISOString())}` : `${library.length} papers · GitHub inbox`}</small>
              </span>
              <ActionButton variant="secondary" size="small" onClick={() => void syncGithub()} disabled={syncing} aria-label="Sync the GitHub inbox" icon={<RefreshCw className={syncing ? "spin" : ""} size={15} />} kbd={`${modKey}S`}>
                {syncing ? syncProgress ? `Syncing ${syncProgress}…` : "Syncing…" : "Sync"}
              </ActionButton>
            </div>
          </div>
        ) : null}
      </aside>

      <div
        className="feed-sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the feed list"
        onPointerDown={startSidebarResize}
        onDoubleClick={() => { setSidebarWidth(320); window.localStorage.setItem(FEED_SIDEBAR_KEY, "320"); }}
      />

      <div className="feed-detail-pane">
        {showDetail && selected ? (
          <FeedDetail
            key={selected.id}
            snippet={selected}
            library={library}
            collections={collections}
            models={models}
            defaultModelLabel={defaultModelLabel}
            defaultEffort={defaultEffort}
            historySelectionRequest={historySelectionRequest?.id === selected.id ? historySelectionRequest : null}
            onHistorySelectionClosed={() => setHistorySelectionRequest(null)}
            siblings={snippets}
            onOpenFeed={(id) => { setComposing(false); setSelectedId(id); }}
            onRename={(title) => renameSnippet(selected, title)}
            onFork={() => forkSnippet(selected)}
            onExport={() => exportSnippet(selected)}
            onBack={() => setSelectedId(null)}
            onChanged={loadSnippets}
            onCreated={(id) => {
              void loadSnippets().then(() => {
                setComposing(false);
                setSelectedId(id);
              });
            }}
          />
        ) : (
          <>
            <header className="feed-detail-head">
              <div className="feed-detail-head-inner">
                <button type="button" className="feed-detail-back feed-compose-back" onClick={() => setComposing(false)} aria-label="Back to list"><ArrowLeft size={16} /></button>
                <div className="feed-detail-heading"><h1>New feed</h1></div>
              </div>
            </header>
            <div className="feed-compose">
            <div className="feed-compose-hero">
              <h2>What should the agent work on?</h2>
              <p>It proposes changes; you approve them.</p>
              <div className="feed-skills">
                {skills.map((skill) => {
                  const Icon = feedSkillIcon(skill.icon);
                  return (
                    <button type="button" key={skill.id} className="feed-skill" onClick={() => setInitialText(skill.prompt)}>
                      <Icon size={14} /> {skill.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <AttachBox
              key={`${initialText}:${initialPapers.map((p) => p.id).join(",")}`}
              library={library}
              models={models}
              defaultModelLabel={defaultModelLabel}
              defaultEffortLabel={defaultEffort}
              placeholder="A link or a note, and what to do with it."
              submitLabel="Add to feed"
              submitting={submitting}
              autoFocus
              initialText={initialText}
              initialPapers={initialPapers}
              hint={<><kbd>⌥↵</kbd> newline</>}
              onSubmit={createSnippet}
            />
            </div>
          </>
        )}
      </div>
      {syncAlert ? <SyncFailureToast failure={syncAlert} onDismiss={() => setSyncAlert(null)} /> : null}
    </main>
  );
}
