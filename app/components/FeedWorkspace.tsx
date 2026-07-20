"use client";

import { ArrowLeft, Check, CircleAlert, Home, LoaderCircle, Rss, Send, Square, Wrench, X } from "lucide-react";
import Link from "next/link";
import { FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { ActionButton } from "@/app/components/ui/controls";

interface FeedMessage {
  id: string;
  role: string;
  kind: string;
  content: string;
  createdAt: string;
}

interface FeedProposal {
  id: string;
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
  createdAt: string;
  updatedAt: string;
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

/** The agent's most useful line for the collapsed card summary. */
function summaryText(messages: FeedMessage[]): string {
  const spoken = messages.filter((m) => m.role === "assistant" && (m.kind === "text" || m.kind === "result"));
  const last = spoken[spoken.length - 1];
  if (!last) {
    const err = messages.find((m) => m.kind === "error");
    return err ? err.content : "";
  }
  return last.content.replace(/```[\s\S]*?```/g, "").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
}

/**
 * A single feed card. Collapsed, it shows the instruction + status + a one-line
 * summary of the agent's result. Expanded, it streams the full thread, shows
 * proposals to approve/reject, and offers a reply box. Each card owns its own
 * SSE connection so the feed can hold many cards independently.
 */
function FeedCard({ snippet, expanded, onToggle, onChanged }: {
  snippet: FeedSnippet;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [messages, setMessages] = useState<FeedMessage[]>([]);
  const [proposals, setProposals] = useState<FeedProposal[]>([]);
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streamNonce, setStreamNonce] = useState(0);
  const running = snippet.status === "running" || snippet.status === "queued";

  // Stream this card's events while it's expanded OR running (so a collapsed
  // card still advances to done). Re-runs on reply (streamNonce) and status flip.
  useEffect(() => {
    if (!expanded && !running) {
      return;
    }
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
  }, [snippet.id, expanded, running, streamNonce]);

  async function sendReply(event: FormEvent) {
    event.preventDefault();
    const text = reply.trim();
    if (!text || replying) {
      return;
    }
    setReplying(true);
    setError(null);
    try {
      const response = await fetch(`/api/feed/snippets/${snippet.id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: text }),
      });
      if (response.ok) {
        setReply("");
        setStreamNonce((nonce) => nonce + 1);
        onChanged();
      } else {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        setError(payload.error ?? `Reply failed (${response.status}).`);
      }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Reply failed.");
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
          ? { ...proposal, status: nextStatus, summary: payload.error ? `${proposal.summary} — ${payload.error}` : proposal.summary }
          : proposal,
      ));
    } finally {
      setResolving(null);
    }
  }

  const summary = summaryText(messages);
  const pendingCount = proposals.filter((p) => p.status === "pending").length;

  return (
    <article className={`feed-card feed-card-${snippet.status} ${expanded ? "is-expanded" : ""}`}>
      <button type="button" className="feed-card-head" onClick={onToggle} aria-expanded={expanded}>
        <div className="feed-card-head-main">
          <strong>{snippet.title || snippet.instruction || "Untitled"}</strong>
          {!expanded && summary ? <p className="feed-card-summary">{summary}</p> : null}
        </div>
        <div className="feed-card-head-meta">
          <span className={`feed-status feed-status-${snippet.status}`}>
            {running ? <LoaderCircle className="spin" size={11} /> : snippet.status === "error" ? <CircleAlert size={11} /> : null}
            {statusLabel(snippet.status)}
          </span>
          {pendingCount ? <span className="feed-card-badge">{pendingCount} to approve</span> : null}
          <span className="feed-card-time">{relativeTime(snippet.updatedAt)}</span>
        </div>
      </button>

      {expanded ? (
        <div className="feed-card-body">
          {snippet.instruction && snippet.instruction !== snippet.title ? (
            <div className="feed-message feed-turn feed-turn-user">
              <span className="feed-turn-label">You</span>
              <MarkdownContent content={snippet.instruction} className="feed-bubble" />
            </div>
          ) : null}
          <div className="feed-thread">
            {messages.length === 0 && running ? <div className="typing chat-workspace-typing" role="status"><i /><i /><i /></div> : null}
            {(() => {
              const nodes: ReactNode[] = [];
              for (let i = 0; i < messages.length; i += 1) {
                const message = messages[i];
                if (message.kind === "tool_use") {
                  const next = messages[i + 1];
                  const resultMessage = next && next.kind === "tool_result" ? next : null;
                  if (resultMessage) i += 1;
                  const space = message.content.indexOf(" ");
                  const toolName = space === -1 ? message.content : message.content.slice(0, space);
                  const toolInput = space === -1 ? "" : message.content.slice(space + 1);
                  nodes.push(
                    <details key={message.id} className="feed-tool-call">
                      <summary><Wrench size={12} /> <span>{toolName}</span></summary>
                      <div className="feed-tool-io">
                        {toolInput ? <code className="feed-tool-block">{toolInput}</code> : null}
                        {resultMessage ? <code className="feed-tool-block feed-tool-result">{resultMessage.content}</code> : null}
                      </div>
                    </details>,
                  );
                  continue;
                }
                if (message.kind === "tool_result") {
                  nodes.push(
                    <details key={message.id} className="feed-tool-call">
                      <summary><ArrowLeft size={12} /> <span>tool result</span></summary>
                      <div className="feed-tool-io"><code className="feed-tool-block feed-tool-result">{message.content}</code></div>
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
                nodes.push(
                  <div key={message.id} className={`feed-message feed-turn feed-turn-${message.role}`}>
                    <span className="feed-turn-label">{message.role === "user" ? "You" : "Agent"}</span>
                    <MarkdownContent content={message.content} className="feed-bubble" />
                  </div>,
                );
              }
              return nodes;
            })()}
          </div>

          {proposals.length ? (
            <div className="feed-proposals">
              <h2>Proposed library changes</h2>
              {proposals.map((proposal) => (
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
          ) : null}

          {error ? <div className="feed-error feed-error-banner"><CircleAlert size={14} /> <span>{error}</span></div> : null}

          {running ? (
            <div className="feed-card-actions">
              <ActionButton variant="secondary" size="small" onClick={() => void stop()} icon={<Square size={14} />}>Stop</ActionButton>
            </div>
          ) : (
            <form className="feed-reply" onSubmit={sendReply}>
              <textarea
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder="Reply to continue this thread — the agent keeps its context…"
                rows={2}
              />
              <ActionButton type="submit" variant="primary" disabled={!reply.trim() || replying} icon={replying ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}>Reply</ActionButton>
            </form>
          )}
        </div>
      ) : null}
    </article>
  );
}

export default function FeedWorkspace() {
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [snippets, setSnippets] = useState<FeedSnippet[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadSnippets = useCallback(async () => {
    const response = await fetch("/api/feed/snippets", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json() as { snippets: FeedSnippet[] };
      setSnippets(data.snippets);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/local-settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then(async (data: { feedEnabled?: boolean } | null) => {
        if (cancelled) return;
        const on = Boolean(data?.feedEnabled);
        setEnabled(on);
        if (on) {
          await loadSnippets();
        }
        setReady(true);
      })
      .catch(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [loadSnippets]);

  // Poll while anything is running so statuses/summaries settle even if a card
  // isn't expanded to stream its own events.
  useEffect(() => {
    if (!snippets.some((snippet) => snippet.status === "running" || snippet.status === "queued")) {
      return;
    }
    const timer = window.setInterval(() => void loadSnippets(), 4000);
    return () => window.clearInterval(timer);
  }, [snippets, loadSnippets]);

  async function createSnippet(event: FormEvent) {
    event.preventDefault();
    const text = instruction.trim();
    if (!text || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/feed/snippets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: text }),
      });
      if (response.ok) {
        const { id } = await response.json() as { id: string };
        setInstruction("");
        await loadSnippets();
        setExpandedId(id);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!ready) {
    return <main className="chat-workspace-loading"><span className="assistant-orb"><Rss size={18} /></span><p>Opening your feed…</p></main>;
  }
  if (!enabled) {
    return (
      <main className="chat-workspace-loading">
        <p>The AI feed is turned off. Enable it in Settings → AI &amp; models → AI feed.</p>
        <Link href="/"><Home size={16} /> Return to library</Link>
      </main>
    );
  }

  return (
    <main className="feed-page">
      <div className="feed-column">
        <header className="feed-column-header">
          <Link href="/" aria-label="Return to Paper Assistant" className="feed-brand"><span className="brand-mark compact">PA</span><span><strong>Paper Assistant</strong><small>AI feed</small></span></Link>
        </header>
        <form className="feed-composer" onSubmit={createSnippet}>
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="Capture anything — paste a link or note, and say what to do (e.g. summarize it, make a TODO list, add it to my library)…"
            rows={3}
          />
          <div className="feed-composer-actions">
            <ActionButton type="submit" variant="primary" disabled={!instruction.trim() || submitting} icon={submitting ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}>Add to feed</ActionButton>
          </div>
        </form>
        <div className="feed-cards">
          {snippets.length === 0 ? (
            <div className="feed-cards-empty">
              <span className="message-avatar"><Rss size={24} /></span>
              <p>Nothing captured yet. Paste a link or a note above and an agent will work on it — its result appears here as a card.</p>
            </div>
          ) : null}
          {snippets.map((snippet) => (
            <FeedCard
              key={snippet.id}
              snippet={snippet}
              expanded={expandedId === snippet.id}
              onToggle={() => setExpandedId((current) => (current === snippet.id ? null : snippet.id))}
              onChanged={loadSnippets}
            />
          ))}
        </div>
      </div>
    </main>
  );
}
