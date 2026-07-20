"use client";

import { Check, CircleAlert, Home, LoaderCircle, Rss, Send, Square, X } from "lucide-react";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
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

function finalResult(messages: FeedMessage[]): FeedMessage | null {
  const results = messages.filter((message) => message.kind === "result" || message.kind === "error");
  if (results.length) {
    return results[results.length - 1];
  }
  const assistant = messages.filter((message) => message.role === "assistant" && message.kind === "text");
  return assistant.length ? assistant[assistant.length - 1] : null;
}

export default function FeedWorkspace() {
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [snippets, setSnippets] = useState<FeedSnippet[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<FeedMessage[]>([]);
  const [proposals, setProposals] = useState<FeedProposal[]>([]);
  const [instruction, setInstruction] = useState("");
  const [reply, setReply] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [replying, setReplying] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [streamNonce, setStreamNonce] = useState(0);
  const eventsRef = useRef<EventSource | null>(null);

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

  // Reset the thread when switching snippets (not on a reply re-stream).
  useEffect(() => {
    setMessages([]);
    setProposals([]);
    setReply("");
  }, [activeId]);

  // Stream the active snippet's events. Re-runs on a reply (streamNonce bump) to
  // pick up the new turn; the events route replays history and the dedup guards
  // below keep the thread from doubling.
  useEffect(() => {
    eventsRef.current?.close();
    eventsRef.current = null;
    if (!activeId) {
      return;
    }
    const source = new EventSource(`/api/feed/snippets/${activeId}/events`);
    eventsRef.current = source;
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
      void loadSnippets();
    });
    return () => source.close();
  }, [activeId, streamNonce, loadSnippets]);

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
        setActiveId(id);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function stopSnippet(id: string) {
    await fetch(`/api/feed/snippets/${id}/stop`, { method: "POST" });
  }

  async function sendReply(event: FormEvent) {
    event.preventDefault();
    const text = reply.trim();
    if (!text || replying || !activeId) {
      return;
    }
    setReplying(true);
    try {
      const response = await fetch(`/api/feed/snippets/${activeId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: text }),
      });
      if (response.ok) {
        setReply("");
        // Re-open the event stream to follow the resumed turn.
        setStreamNonce((nonce) => nonce + 1);
        void loadSnippets();
      }
    } finally {
      setReplying(false);
    }
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

  const active = snippets.find((snippet) => snippet.id === activeId) ?? null;

  return (
    <main className="feed-page">
      <aside className="feed-sidebar">
        <header className="feed-sidebar-header">
          <Link href="/" aria-label="Return to Paper Assistant"><span className="brand-mark compact">PA</span><span><strong>Paper Assistant</strong><small>AI feed</small></span></Link>
        </header>
        <form className="feed-composer" onSubmit={createSnippet}>
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="Capture anything — paste a link or note, and say what to do (e.g. summarize it, make a TODO list)…"
            rows={3}
          />
          <ActionButton type="submit" variant="primary" disabled={!instruction.trim() || submitting} icon={submitting ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}>Add to feed</ActionButton>
        </form>
        <div className="feed-snippet-list">
          {snippets.length === 0 ? <p className="feed-empty-hint">No snippets yet. Capture something above.</p> : null}
          {snippets.map((snippet) => (
            <button
              key={snippet.id}
              className={`feed-snippet-item ${snippet.id === activeId ? "is-active" : ""}`}
              onClick={() => setActiveId(snippet.id)}
            >
              <strong>{snippet.title || "Untitled snippet"}</strong>
              <span className={`feed-status feed-status-${snippet.status}`}>
                {snippet.status === "running" ? <LoaderCircle className="spin" size={11} /> : snippet.status === "error" ? <CircleAlert size={11} /> : null}
                {statusLabel(snippet.status)}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="feed-detail">
        {!active ? (
          <div className="chat-empty-state">
            <span className="message-avatar"><Rss size={26} /></span>
            <div><h1>Your AI feed</h1><p>Select a snippet, or capture something new. Each snippet runs a headless Claude agent; its result appears here.</p></div>
          </div>
        ) : (
          <>
            <header className="feed-detail-header">
              <div><strong>{active.title || "Untitled snippet"}</strong><small className={`feed-status feed-status-${active.status}`}>{statusLabel(active.status)}</small></div>
              {active.status === "running" ? <ActionButton variant="secondary" size="small" onClick={() => void stopSnippet(active.id)} icon={<Square size={14} />}>Stop</ActionButton> : null}
            </header>
            <div className="feed-thread">
              {messages.length === 0 && active.status === "running" ? (
                <div className="typing chat-workspace-typing" role="status"><i /><i /><i /></div>
              ) : null}
              {(() => {
                const final = finalResult(messages);
                return messages.map((message) => (
                  <div key={message.id} className={`feed-message feed-message-${message.kind}`}>
                    {message.kind === "tool_use" ? (
                      <code className="feed-tool">{message.content}</code>
                    ) : message.kind === "error" ? (
                      <div className="feed-error"><CircleAlert size={14} /> <span>{message.content}</span></div>
                    ) : (
                      <MarkdownContent content={message.content} className={`feed-bubble ${message.id === final?.id ? "is-final" : ""}`} />
                    )}
                  </div>
                ));
              })()}
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
            </div>
            {active.status !== "running" ? (
              <form className="feed-reply" onSubmit={sendReply}>
                <textarea
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  placeholder="Reply to continue this thread — the agent keeps its context…"
                  rows={2}
                />
                <ActionButton type="submit" variant="primary" disabled={!reply.trim() || replying} icon={replying ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}>Reply</ActionButton>
              </form>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
