"use client";

import { ArrowDown, ArrowLeft, Check, ChevronUp, CircleAlert, CircleCheck, CircleDot, Code2, Download, GitBranch, ListChecks, LoaderCircle, MoreVertical, Paperclip, Pencil, Plus, RefreshCw, Rss, Square, Trash2, Wrench, X } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AttachBox, type AttachSubmit, type LibraryPaper } from "@/app/components/feed/AttachBox";
import { DEFAULT_FEED_SKILLS, type FeedSkill, feedSkillIcon } from "@/app/lib/feed-skills";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { Brand } from "@/app/components/ui/Brand";
import { ActionButton } from "@/app/components/ui/controls";
import { ThemeToggle } from "@/app/components/ui/ThemeToggle";

interface FeedAttachment {
  relativePath: string;
  label: string;
  kind: "paper-pdf" | "paper-html" | "upload";
}

interface FeedMessage {
  id: string;
  role: string;
  kind: string;
  content: string;
  toolUseId?: string | null;
  attachments?: string | null;
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

interface FeedSnippet {
  id: string;
  title: string;
  instruction: string;
  status: string;
  error: string | null;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  turns?: number;
  attachments?: string | null;
  pendingProposals?: number;
  createdAt: string;
  updatedAt: string;
}

/** Parse the stored attachments JSON (tolerant of nulls / malformed rows). */
function parseAttachments(raw: string | null | undefined): FeedAttachment[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as FeedAttachment[]) : [];
  } catch {
    return [];
  }
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
        {attachments.map((attachment) => {
          const name = attachment.relativePath.split("/").pop() ?? attachment.label;
          const href = `/api/feed/snippets/${snippetId}/attachments/${encodeURIComponent(name)}`;
          // Pasted/short text opens an in-app viewer (like the composer's text
          // editor); binary files (PDF/HTML/image) open in a new tab.
          const isText = /\.(txt|md|markdown)$/i.test(name);
          if (isText) {
            return (
              <button type="button" key={attachment.relativePath} className="feed-turn-attachment" onClick={() => void openText(name, attachment.label)} disabled={loading} title={`View ${attachment.label}`}>
                <Paperclip size={12} />
                <span>{attachment.label}</span>
              </button>
            );
          }
          return (
            <a key={attachment.relativePath} href={href} target="_blank" rel="noreferrer" className="feed-turn-attachment" title={`Open ${attachment.label}`}>
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
  status: "success" | "error";
  summary: string;
}
const SYNC_LOG_KEY = "stacks-sync-log-v1";

function readSyncLog(): SyncLogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SYNC_LOG_KEY) || "[]") as SyncLogEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
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

/**
 * The feed sidebar's bottom bar: a highlighted Sync button plus a collapsible
 * activity log of past syncs. One row; the log panel is portaled to <body> so
 * the sidebar's overflow:hidden can't clip it.
 */
function SyncActivityDock({ log, onClear, syncing, onSync }: {
  log: SyncLogEntry[];
  onClear: () => void;
  syncing: boolean;
  onSync: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const panel = open && mounted ? createPortal(
    <>
      <div className="feed-sync-scrim" onClick={() => setOpen(false)} />
      <div className="feed-sync-panel" role="dialog" aria-label="Sync activity">
        <header>
          <span><RefreshCw size={15} /><strong>Sync activity</strong></span>
          <div>
            <button type="button" className="activity-clear" onClick={onClear} disabled={!log.length}>Clear</button>
            <button type="button" onClick={() => setOpen(false)} aria-label="Collapse sync activity"><X size={15} /></button>
          </div>
        </header>
        <div className="feed-sync-panel-list">
          {!log.length ? <p className="activity-log-empty">GitHub inbox syncs will be logged here.</p> : log.map((entry) => (
            <div className={`feed-sync-log-row is-${entry.status}`} key={entry.id}>
              {entry.status === "success" ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
              <span><strong>{entry.summary}</strong><small>{new Date(entry.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small></span>
            </div>
          ))}
        </div>
      </div>
    </>,
    document.body,
  ) : null;

  return (
    <div className="feed-sync-bar">
      <ActionButton variant="primary" size="small" className="feed-sync-run" onClick={onSync} disabled={syncing} icon={syncing ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}>{syncing ? "Syncing…" : "Sync inbox"}</ActionButton>
      <button type="button" className={`feed-sync-toggle ${open ? "is-open" : ""}`} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <ListChecks size={15} />
        <span>Activity</span>
        <ChevronUp size={14} />
      </button>
      {panel}
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
function renderToolContent(content: string): ReactNode {
  if (!content.trim()) {
    return <p className="feed-tool-empty">No output</p>;
  }
  return <MarkdownContent content={toolFence(content)} className="feed-tool-md" />;
}

/** Compact token count: 1234 → "1.2k", 20345 → "20.3k". */
function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
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
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
}

/**
 * A single row in the left list: status glyph, title, and a relative timestamp,
 * on one line so the console scales to dozens of interactions, plus an overflow
 * menu (rename / fork / export / delete). Statuses stay fresh via the poll.
 */
function FeedRow({ snippet, active, onSelect, onRename, onFork, onExport, onDelete }: {
  snippet: FeedSnippet;
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onFork: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const run = (action: () => void) => () => { setMenuOpen(false); action(); };

  return (
    <div className={`feed-row feed-row-${snippet.status} ${active ? "is-active" : ""} ${menuOpen ? "menu-open" : ""}`}>
      <button type="button" className="feed-row-main" onClick={onSelect} aria-current={active}>
        <span className={`feed-row-glyph feed-status-${snippet.status}`}><StatusGlyph status={snippet.status} /></span>
        <span className="feed-row-body">
          <span className="feed-row-title-line">
            <span className="feed-row-title">{snippet.title || snippet.instruction || "Untitled"}</span>
            {snippet.pendingProposals ? <span className="feed-row-pending" title={`${snippet.pendingProposals} change${snippet.pendingProposals === 1 ? "" : "s"} to approve`}>{snippet.pendingProposals}</span> : null}
          </span>
          <span className="feed-row-meta">
            <span className={`feed-row-status feed-status-${snippet.status}`}>{statusLabel(snippet.status)}</span>
            <span className="feed-row-time">{relativeTime(snippet.updatedAt)}</span>
            {(() => {
              const tokens = (snippet.inputTokens ?? 0) + (snippet.outputTokens ?? 0);
              return tokens ? <span>{compactTokens(tokens)} tok</span> : null;
            })()}
            {snippet.turns ? <span>{snippet.turns} {snippet.turns === 1 ? "turn" : "turns"}</span> : null}
          </span>
        </span>
      </button>
      <div className="feed-row-menu" ref={menuRef}>
        <button type="button" className="feed-row-kebab" onClick={() => setMenuOpen((open) => !open)} aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen}><MoreVertical size={15} /></button>
        {menuOpen ? (
          <div className="feed-row-menu-list" role="menu">
            <button type="button" role="menuitem" onClick={run(onRename)}><Pencil size={14} /> Rename</button>
            <button type="button" role="menuitem" onClick={run(onFork)}><GitBranch size={14} /> Fork</button>
            <button type="button" role="menuitem" onClick={run(onExport)}><Download size={14} /> Export</button>
            <button type="button" role="menuitem" className="is-danger" onClick={run(onDelete)}><Trash2 size={14} /> Delete</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The right detail pane: the selected snippet's full thread. Streams its own SSE
 * (history is replayed on connect, so any snippet — live or long-finished — fills
 * in), shows proposals to approve/reject, and offers a reply box. Mounted with a
 * `key` of the snippet id so switching selection resets its state cleanly.
 */
function FeedDetail({ snippet, library, onBack, onChanged }: {
  snippet: FeedSnippet;
  library: LibraryPaper[];
  onBack: () => void;
  onChanged: () => void;
}) {
  const [messages, setMessages] = useState<FeedMessage[]>([]);
  const [proposals, setProposals] = useState<FeedProposal[]>([]);
  const [replying, setReplying] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streamNonce, setStreamNonce] = useState(0);
  const running = snippet.status === "running" || snippet.status === "queued";
  const bodyRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToBottom = useCallback(() => {
    const body = bodyRef.current;
    if (body) body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
  }, []);

  // Auto-scroll to the newest content as it streams in, but only when the user
  // is already near the bottom — so scrolling up to re-read isn't yanked back.
  // Content growth doesn't fire a scroll event, so we also re-measure the
  // near-bottom state here (not just on the scroll listener), which is why
  // opening a long thread correctly shows the jump-to-latest button.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
    if (nearBottom) {
      body.scrollTop = body.scrollHeight;
    }
    setAtBottom(body.scrollHeight - body.scrollTop - body.clientHeight < 120);
  }, [messages, proposals, running]);

  // Track whether the user is near the bottom, to toggle the jump-to-latest button.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onScroll = () => setAtBottom(body.scrollHeight - body.scrollTop - body.clientHeight < 120);
    onScroll();
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, []);

  // Stream this snippet's events. The endpoint replays persisted history first,
  // then live events if it's still running, then closes. Re-runs on reply.
  useEffect(() => {
    const source = new EventSource(`/api/feed/snippets/${snippet.id}/events`);
    source.addEventListener("message", (event) => {
      const message = JSON.parse((event as MessageEvent).data) as FeedMessage;
      setMessages((current) => (current.some((m) => m.id === message.id) ? current : [...current, message]));
    });
    source.addEventListener("proposal", (event) => {
      const proposal = JSON.parse((event as MessageEvent).data) as FeedProposal;
      setProposals((current) => (current.some((p) => p.id === proposal.id) ? current : [...current, proposal]));
    });
    source.addEventListener("done", () => {
      source.close();
      onChanged();
    });
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snippet.id, streamNonce]);

  async function sendReply(payload: AttachSubmit): Promise<boolean> {
    setReplying(true);
    setError(null);
    try {
      let response: Response;
      if (payload.files.length || payload.paperIds.length) {
        const form = new FormData();
        form.set("reply", payload.text);
        for (const file of payload.files) form.append("files", file);
        for (const paperId of payload.paperIds) form.append("paperIds", paperId);
        response = await fetch(`/api/feed/snippets/${snippet.id}/reply`, { method: "POST", body: form });
      } else {
        response = await fetch(`/api/feed/snippets/${snippet.id}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reply: payload.text }),
        });
      }
      if (response.ok) {
        setStreamNonce((nonce) => nonce + 1);
        onChanged();
        return true;
      }
      const body = await response.json().catch(() => ({})) as { error?: string };
      setError(body.error ?? `Reply failed (${response.status}).`);
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

  async function resolveProposal(proposalId: string, decision: "approve" | "reject") {
    setResolving(proposalId);
    try {
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
    } finally {
      setResolving(null);
    }
  }

  const pendingCount = proposals.filter((p) => p.status === "pending").length;

  // Anchor each proposal to the assistant message that produced it, so it renders
  // inline in the thread instead of always pinned to the bottom. Proposals with
  // no (or an unknown) message id — e.g. legacy rows or API-created ones — fall
  // back to a trailing block.
  const proposalsByMessage = new Map<string, FeedProposal[]>();
  for (const proposal of proposals) {
    if (!proposal.messageId) continue;
    const group = proposalsByMessage.get(proposal.messageId) ?? [];
    group.push(proposal);
    proposalsByMessage.set(proposal.messageId, group);
  }
  const messageIds = new Set(messages.map((message) => message.id));
  // Proposals with no anchor message (legacy rows, or ones created via the
  // library API) can't be interleaved, so they render in a trailing block.
  const unanchoredProposals = proposals.filter((proposal) => !proposal.messageId || !messageIds.has(proposal.messageId));

  function renderProposals(list: FeedProposal[], key: string): ReactNode {
    if (!list.length) return null;
    return (
      <div className="feed-proposals" key={key}>
        <h2><Check size={13} /> Proposed library changes</h2>
        {list.map((proposal) => (
          <div key={proposal.id} className={`feed-proposal feed-proposal-${proposal.status}`}>
            <div className="feed-proposal-body">
              <span className="feed-proposal-summary">{proposal.summary}</span>
              <span className="feed-proposal-status">{proposal.status}</span>
            </div>
            {proposal.status === "pending" ? (
              <div className="feed-proposal-actions">
                <ActionButton variant="secondary" size="small" disabled={resolving === proposal.id} onClick={() => void resolveProposal(proposal.id, "reject")} icon={<X size={13} />}>Reject</ActionButton>
                <ActionButton variant="primary" size="small" disabled={resolving === proposal.id} onClick={() => void resolveProposal(proposal.id, "approve")} icon={resolving === proposal.id ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}>Approve</ActionButton>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    );
  }

  return (
    <section className="feed-detail">
      <header className="feed-detail-head">
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
            </div>
          </div>
          {pendingCount ? <span className="feed-detail-badge">{pendingCount} to approve</span> : null}
        </div>
      </header>

      <div className="feed-detail-body" ref={bodyRef}>
        <div className="feed-detail-body-inner">
        {(() => {
          const openingAttachments = parseAttachments(snippet.attachments);
          const showOpening = (snippet.instruction && snippet.instruction !== snippet.title) || openingAttachments.length > 0;
          if (!showOpening) return null;
          return (
            <div className="feed-message feed-turn feed-turn-user">
              <span className="feed-turn-label">You</span>
              {snippet.instruction && snippet.instruction !== snippet.title
                ? <MarkdownContent content={snippet.instruction} className="feed-bubble" />
                : null}
              <AttachmentChips snippetId={snippet.id} attachments={openingAttachments} />
            </div>
          );
        })()}
        <div className="feed-thread">
          {messages.length === 0 && running ? <div className="typing chat-workspace-typing" role="status"><i /><i /><i /></div> : null}
          {(() => {
            const nodes: ReactNode[] = [];
            // Pair each tool_use with its result by tool_use id — the agent can
            // issue calls in parallel (use A, use B, result A, result B), so
            // position alone mispairs them. Results claimed by id are skipped
            // when the loop reaches them.
            const resultById = new Map<string, FeedMessage>();
            for (const message of messages) {
              if (message.kind === "tool_result" && message.toolUseId) {
                resultById.set(message.toolUseId, message);
              }
            }
            const claimed = new Set<string>();
            for (let i = 0; i < messages.length; i += 1) {
              const message = messages[i];
              if (message.kind === "tool_use") {
                let resultMessage: FeedMessage | null = null;
                if (message.toolUseId && resultById.has(message.toolUseId)) {
                  resultMessage = resultById.get(message.toolUseId) ?? null;
                  if (resultMessage) claimed.add(resultMessage.id);
                } else {
                  // Legacy rows without ids: fall back to the adjacent result.
                  const next = messages[i + 1];
                  if (next && next.kind === "tool_result" && !next.toolUseId) {
                    resultMessage = next;
                    claimed.add(next.id);
                  }
                }
                const space = message.content.indexOf(" ");
                const toolName = space === -1 ? message.content : message.content.slice(0, space);
                const toolInput = space === -1 ? "" : message.content.slice(space + 1);
                nodes.push(
                  <details key={message.id} className="feed-tool-call">
                    <summary><Wrench size={12} /> <span>{toolName}</span></summary>
                    <div className="feed-tool-io">
                      <span className="feed-tool-tag">Request</span>
                      {renderToolContent(toolInput)}
                      {resultMessage ? <><span className="feed-tool-tag">Result</span>{renderToolContent(resultMessage.content)}</> : null}
                    </div>
                  </details>,
                );
                continue;
              }
              if (message.kind === "tool_result") {
                // Skip results already shown inside their matching tool_use.
                if (claimed.has(message.id)) {
                  continue;
                }
                nodes.push(
                  <details key={message.id} className="feed-tool-call">
                    <summary><Wrench size={12} /> <span>tool result</span></summary>
                    <div className="feed-tool-io"><span className="feed-tool-tag">Result</span>{renderToolContent(message.content)}</div>
                  </details>,
                );
                continue;
              }
              if (message.kind === "error") {
                nodes.push(
                  <div key={message.id} className="feed-message feed-message-error">
                    <div className="feed-error"><CircleAlert size={14} /> <span>{message.content}</span></div>
                  </div>,
                );
                continue;
              }
              const { prose: rawProse, raw } = message.role === "user" ? { prose: message.content, raw: null } : splitProposalBlock(message.content);
              const messageAttachments = message.role === "user" ? parseAttachments(message.attachments) : [];
              // Drop the "(attached N files)" placeholder when the chips convey it.
              const prose = messageAttachments.length && /^\(attached \d+ files?\)$/.test(rawProse.trim()) ? "" : rawProse;
              if (prose || messageAttachments.length) {
                nodes.push(
                  <div key={message.id} className={`feed-message feed-turn feed-turn-${message.role}`}>
                    <span className="feed-turn-label">{message.role === "user" ? "You" : "Agent"}</span>
                    {prose ? <MarkdownContent content={prose} className="feed-bubble" /> : null}
                    <AttachmentChips snippetId={snippet.id} attachments={messageAttachments} />
                  </div>,
                );
              }
              if (raw) {
                nodes.push(
                  <details key={`${message.id}-raw`} className="feed-tool-call feed-proposal-raw">
                    <summary><Code2 size={12} /> <span>Proposed changes (raw)</span></summary>
                    <div className="feed-tool-io"><span className="feed-tool-tag">stacks-proposals</span>{renderToolContent(raw)}</div>
                  </details>,
                );
              }
              const anchored = proposalsByMessage.get(message.id);
              if (anchored) {
                nodes.push(renderProposals(anchored, `props-${message.id}`));
              }
            }
            return nodes;
          })()}
        </div>

        {renderProposals(unanchoredProposals, "props-unanchored")}

        {error ? <div className="feed-error feed-error-banner"><CircleAlert size={14} /> <span>{error}</span></div> : null}
        </div>
      </div>

      <footer className="feed-detail-foot">
        {!atBottom ? (
          <button type="button" className="feed-scroll-bottom" onClick={scrollToBottom} aria-label="Scroll to latest">
            <ArrowDown size={16} />
          </button>
        ) : null}
        <AttachBox
          library={library}
          placeholder={running ? "The agent is working. Send to interrupt and steer it." : "Reply to continue this thread. The agent keeps its context."}
          submitLabel={running ? "Interrupt & send" : "Reply"}
          submitting={replying}
          compact
          onSubmit={sendReply}
          leadingAction={running ? (
            <button type="button" className="feed-tool-btn" onClick={() => void stop()} title="Stop the agent" aria-label="Stop the agent"><Square size={15} /></button>
          ) : undefined}
        />
      </footer>
    </section>
  );
}

export default function FeedWorkspace() {
  const [ready, setReady] = useState(false);
  const [snippets, setSnippets] = useState<FeedSnippet[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [library, setLibrary] = useState<LibraryPaper[]>([]);
  const [skills, setSkills] = useState<FeedSkill[]>(DEFAULT_FEED_SKILLS);
  const [initialText, setInitialText] = useState("");
  const [initialPapers, setInitialPapers] = useState<LibraryPaper[]>([]);
  const [githubReady, setGithubReady] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [syncLog, setSyncLog] = useState<SyncLogEntry[]>([]);

  useEffect(() => { setSyncLog(readSyncLog()); }, []);

  const recordSync = useCallback((status: "success" | "error", summary: string) => {
    setSyncLog((current) => {
      const next = [{ id: crypto.randomUUID(), at: Date.now(), status, summary }, ...current].slice(0, 50);
      writeSyncLog(next);
      return next;
    });
  }, []);
  const clearSyncLog = useCallback(() => { setSyncLog([]); writeSyncLog([]); }, []);

  const loadSnippets = useCallback(async () => {
    const response = await fetch("/api/feed/snippets", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json() as { snippets: FeedSnippet[] };
      setSnippets(data.snippets);
    }
  }, []);

  // GitHub inbox sync is available only once a repo + token are configured.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/local-settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { github?: { repo?: string; connected?: boolean } } | null) => {
        if (!cancelled) setGithubReady(Boolean(data?.github?.repo && data.github.connected));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const syncGithub = useCallback(async () => {
    setSyncing(true);
    setNotice(null);
    try {
      const response = await fetch("/api/feed/github/sync", { method: "POST" });
      const data = (await response.json()) as { counts?: Record<string, number>; truncated?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error ?? "GitHub sync failed.");
      const c = data.counts ?? {};
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
      ].filter(Boolean);
      const base = parts.length ? `Synced: ${parts.join(", ")}.` : "Synced. Already up to date.";
      const message = data.truncated ? `${base} More remain; sync again to continue.` : base;
      setNotice({ tone: "success", message });
      recordSync("success", message);
      await loadSnippets();
    } catch (error) {
      const message = error instanceof Error ? error.message : "GitHub sync failed.";
      setNotice({ tone: "error", message });
      recordSync("error", message);
    } finally {
      setSyncing(false);
    }
  }, [loadSnippets, recordSync]);

  useEffect(() => {
    let cancelled = false;
    void loadSnippets().finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [loadSnippets]);

  // Load the library once so papers can be attached (and the ?paper= param
  // pre-attaches one, opening straight into the composer).
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/library", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { papers?: LibraryPaper[] } | null) => {
        if (cancelled || !data?.papers) return;
        setLibrary(data.papers);
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

  const selected = useMemo(
    () => snippets.find((snippet) => snippet.id === selectedId) ?? null,
    [snippets, selectedId],
  );

  async function createSnippet(payload: AttachSubmit): Promise<boolean> {
    setSubmitting(true);
    try {
      let response: Response;
      if (payload.files.length || payload.paperIds.length) {
        const form = new FormData();
        form.set("instruction", payload.text);
        for (const file of payload.files) form.append("files", file);
        for (const paperId of payload.paperIds) form.append("paperIds", paperId);
        response = await fetch("/api/feed/snippets", { method: "POST", body: form });
      } else {
        response = await fetch("/api/feed/snippets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: payload.text }),
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

  async function renameSnippet(snippet: FeedSnippet) {
    const next = window.prompt("Rename this feed", snippet.title || snippet.instruction || "")?.trim();
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
    const data = await response.json() as { messages: FeedMessage[] };
    const title = snippet.title || snippet.instruction || "feed";
    const lines = [`# ${title}`, ""];
    for (const message of data.messages) {
      if (message.kind === "text" || message.kind === "result") {
        lines.push(`**${message.role === "user" ? "You" : "Agent"}:** ${message.content}`, "");
      } else if (message.kind === "tool_use") {
        lines.push(`> \`${message.content}\``, "");
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
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
    <main className={`feed-page ${showDetail || composing ? "has-selection" : ""}`}>
      <div className="feed-theme-toggle">
        <ThemeToggle />
      </div>
      <aside className="feed-list-pane">
        <header className="feed-list-head">
          <Link href="/" aria-label="Return to Stacks" className="brand"><Brand subtitle="AI feed" /></Link>
          <ActionButton variant="primary" size="small" onClick={() => { setComposing(true); setSelectedId(null); }} icon={<Plus size={14} />}>New</ActionButton>
        </header>
        <div className="feed-list" role="list">
          {snippets.length === 0 ? (
            <p className="feed-list-empty">Nothing captured yet. Start a new feed and the agent goes to work.</p>
          ) : (
            snippets.map((snippet) => (
              <FeedRow
                key={snippet.id}
                snippet={snippet}
                active={snippet.id === selectedId && !composing}
                onSelect={() => { setComposing(false); setSelectedId(snippet.id); }}
                onRename={() => void renameSnippet(snippet)}
                onFork={() => void forkSnippet(snippet)}
                onExport={() => void exportSnippet(snippet)}
                onDelete={() => void deleteSnippet(snippet)}
              />
            ))
          )}
        </div>
        {githubReady ? (
          <div className="feed-sidebar-sync">
            {notice ? <p className={`feed-sync-notice is-${notice.tone}`}>{notice.message}</p> : null}
            <SyncActivityDock log={syncLog} onClear={clearSyncLog} syncing={syncing} onSync={() => void syncGithub()} />
          </div>
        ) : null}
      </aside>

      <div className="feed-detail-pane">
        {showDetail && selected ? (
          <FeedDetail
            key={selected.id}
            snippet={selected}
            library={library}
            onBack={() => setSelectedId(null)}
            onChanged={loadSnippets}
          />
        ) : (
          <div className="feed-compose">
            <button type="button" className="feed-detail-back feed-compose-back" onClick={() => setComposing(false)} aria-label="Back to list"><ArrowLeft size={16} /></button>
            <div className="feed-compose-hero">
              <h2>What should the agent work on?</h2>
              <p>Paste a link or a note, attach a paper or file, and say what to do. It proposes changes; you approve them.</p>
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
              placeholder="Capture anything. A link or a note, and what to do with it."
              submitLabel="Add to feed"
              submitting={submitting}
              autoFocus
              initialText={initialText}
              initialPapers={initialPapers}
              hint="↵ to send · ⌥↵ for a new line"
              onSubmit={createSnippet}
            />
          </div>
        )}
      </div>
    </main>
  );
}
