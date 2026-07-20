"use client";

import { CircleAlert, Home, LoaderCircle, Rss, Send, Square } from "lucide-react";
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
  const [instruction, setInstruction] = useState("");
  const [submitting, setSubmitting] = useState(false);
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
    void fetch("/api/settings", { cache: "no-store" })
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

  // Stream the active snippet's events.
  useEffect(() => {
    eventsRef.current?.close();
    eventsRef.current = null;
    setMessages([]);
    if (!activeId) {
      return;
    }
    const source = new EventSource(`/api/feed/snippets/${activeId}/events`);
    eventsRef.current = source;
    source.addEventListener("message", (event) => {
      const message = JSON.parse((event as MessageEvent).data) as FeedMessage;
      setMessages((current) => (current.some((m) => m.id === message.id) ? current : [...current, message]));
    });
    source.addEventListener("done", () => {
      source.close();
      void loadSnippets();
    });
    return () => source.close();
  }, [activeId, loadSnippets]);

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
            </div>
          </>
        )}
      </section>
    </main>
  );
}
