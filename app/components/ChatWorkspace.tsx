"use client";

import {
  Check,
  FileCheck2,
  FileText,
  Home,
  Menu,
  MessageSquarePlus,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
  Pencil,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { ActionButton, Chip } from "@/app/components/ui/controls";
import type { ChatGrounding, ChatMessage, LibrarySnapshot, Paper } from "@/app/lib/types";

function GroundingReceipt({ grounding }: { grounding?: ChatGrounding }) {
  if (!grounding || !grounding.sources.length) {
    return null;
  }
  const { groundedPapers, paperCount, pdfStartPage, pdfEndPage, sources } = grounding;
  const summary = groundedPapers === 0
    ? "Answered from metadata only"
    : `Grounded in ${groundedPapers} of ${paperCount} ${paperCount === 1 ? "paper" : "papers"} · PDF pp. ${pdfStartPage}–${pdfEndPage}`;
  return (
    <details className="grounding-receipt">
      <summary><FileCheck2 size={13} /> {summary}</summary>
      <ul>
        {sources.map((source, index) => (
          <li key={`${source.title}-${index}`} className={source.grounded ? "is-grounded" : "is-metadata"}>
            {source.grounded ? <Check size={12} /> : <FileText size={12} />}
            <span>{source.title}</span>
            <small>{source.source}</small>
          </li>
        ))}
      </ul>
    </details>
  );
}

const CHAT_HISTORY_KEY = "pa-chat-sessions-v2";
const LEGACY_CHAT_PREFIX = "pa-chat-history-v1:";

interface ChatSession {
  id: string;
  title: string;
  titleMode: "auto" | "custom";
  paperIds: string[];
  pdfStartPage: number;
  pdfEndPage: number | null;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

function readError(response: Response): Promise<string> {
  return response.text().then((text) => {
    try {
      const payload = JSON.parse(text) as { error?: string };
      return payload.error || text || `Request failed with ${response.status}`;
    } catch {
      return text || `Request failed with ${response.status}`;
    }
  });
}

function readSessions(): ChatSession[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHAT_HISTORY_KEY) || "[]") as ChatSession[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((session) => session && typeof session.id === "string" && Array.isArray(session.messages))
      .map((session) => ({
        ...session,
        titleMode: session.titleMode === "custom" ? "custom" as const : "auto" as const,
        paperIds: Array.isArray(session.paperIds) ? session.paperIds : [],
        pdfStartPage: Math.min(20, Math.max(1, Number(session.pdfStartPage) || 1)),
        pdfEndPage: session.pdfEndPage == null ? null : Math.min(20, Math.max(1, Number(session.pdfEndPage) || 1)),
        messages: session.messages.filter((message) => message.id !== "welcome"),
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  }
}

function persistSessions(sessions: ChatSession[]): void {
  window.localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(sessions));
}

function authors(paper: Paper): string {
  return paper.authors.map((author) => author.displayName).join(", ");
}

function venue(paper: Paper): string {
  return paper.venueAcronym || paper.venueName || (paper.paperType === "preprint" ? "arXiv" : "No venue");
}

function automaticTitle(papers: Paper[]): string {
  if (!papers.length) {
    return "New discussion";
  }
  if (papers.length === 1) {
    return papers[0].title;
  }
  return `${papers[0].title} + ${papers.length - 1} ${papers.length === 2 ? "paper" : "papers"}`;
}

function welcomeMessage(papers: Paper[]): string {
  if (!papers.length) {
    return "Select one or more papers to begin a grounded research discussion.";
  }
  if (papers.length === 1) {
    return `I’m ready to think through “${papers[0].title}” with you. Ask about the argument, methods, connections, or next steps.`;
  }
  return `I’m ready to compare ${papers.length} papers with you. Ask about their agreements, differences, methods, evidence, or useful connections.`;
}

function sessionTimestamp(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat("en", sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric" }).format(date);
}

function makeSession(paperIds: string[], papers: Paper[]): ChatSession {
  const now = new Date().toISOString();
  const selected = papers.filter((paper) => paperIds.includes(paper.id));
  return {
    id: crypto.randomUUID(),
    title: automaticTitle(selected),
    titleMode: "auto",
    paperIds: paperIds.slice(0, 8),
    pdfStartPage: 1,
    pdfEndPage: null,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export default function ChatWorkspace() {
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState("");
  const [input, setInput] = useState("");
  const [paperQuery, setPaperQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [ready, setReady] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const flushFrameRef = useRef<number | null>(null);

  const activeSession = sessions.find((session) => session.id === activeId) || null;
  const selectedPapers = useMemo(() => {
    if (!library || !activeSession) {
      return [];
    }
    return library.papers.filter((paper) => activeSession.paperIds.includes(paper.id));
  }, [activeSession, library]);
  const filteredPapers = useMemo(() => {
    if (!library) {
      return [];
    }
    const normalized = paperQuery.trim().toLowerCase();
    if (!normalized) {
      return library.papers;
    }
    return library.papers.filter((paper) => [paper.title, authors(paper), venue(paper), paper.year]
      .some((value) => String(value || "").toLowerCase().includes(normalized)));
  }, [library, paperQuery]);

  const updateSession = useCallback((sessionId: string, updater: (session: ChatSession) => ChatSession) => {
    setSessions((current) => {
      const next = current
        .map((session) => session.id === sessionId ? updater(session) : session)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      persistSessions(next);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      try {
        const response = await fetch("/api/library", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
        const snapshot = await response.json() as LibrarySnapshot;
        if (cancelled) {
          return;
        }
        setLibrary(snapshot);
        const stored = readSessions();
        const migrated = [...stored];
        const migratedIds = new Set(migrated.map((session) => session.id));
        snapshot.papers.forEach((paper) => {
          const legacy = window.localStorage.getItem(`${LEGACY_CHAT_PREFIX}${paper.id}`);
          const legacyId = `legacy-${paper.id}`;
          if (!legacy || migratedIds.has(legacyId)) {
            return;
          }
          try {
            const parsed = JSON.parse(legacy) as { messages?: ChatMessage[]; selectedPaperIds?: string[] };
            const now = new Date().toISOString();
            const paperIds = (parsed.selectedPaperIds || [paper.id]).filter((id) => snapshot.papers.some((candidate) => candidate.id === id)).slice(0, 8);
            const selected = snapshot.papers.filter((candidate) => paperIds.includes(candidate.id));
            migrated.push({
              id: legacyId,
              title: automaticTitle(selected),
              titleMode: "auto",
              paperIds,
              pdfStartPage: 1,
              pdfEndPage: null,
              messages: (parsed.messages || []).filter((message) => message.id !== "welcome"),
              createdAt: now,
              updatedAt: now,
            });
          } catch {
            // Leave malformed legacy state untouched so the main library remains unaffected.
          }
        });
        const availablePaperIds = new Set(snapshot.papers.map((paper) => paper.id));
        for (let index = 0; index < migrated.length; index += 1) {
          const session = migrated[index];
          const paperIds = session.paperIds.filter((paperId) => availablePaperIds.has(paperId)).slice(0, 8);
          const selected = snapshot.papers.filter((paper) => paperIds.includes(paper.id));
          migrated[index] = {
            ...session,
            paperIds,
            title: session.titleMode === "auto" ? automaticTitle(selected) : session.title,
          };
        }
        const params = new URLSearchParams(window.location.search);
        const requestedSession = params.get("session");
        const requestedPaper = params.get("paper");
        let active = requestedSession ? migrated.find((session) => session.id === requestedSession) : undefined;
        if (!active && requestedPaper) {
          active = migrated.find((session) => session.paperIds.includes(requestedPaper));
        }
        if (!active) {
          const initialPaperIds = requestedPaper && snapshot.papers.some((paper) => paper.id === requestedPaper) ? [requestedPaper] : [];
          active = makeSession(initialPaperIds, snapshot.papers);
          migrated.push(active);
        }
        migrated.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        setSessions(migrated);
        setActiveId(active.id);
        persistSessions(migrated);
      } catch {
        setLibrary(null);
      } finally {
        if (!cancelled) {
          setReady(true);
        }
      }
    }
    void initialize();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      // Don't let another tab's write clobber an in-progress stream in this tab.
      if (event.key === CHAT_HISTORY_KEY && !loading) {
        setSessions(readSessions());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [loading]);

  useEffect(() => () => {
    if (flushFrameRef.current !== null) {
      cancelAnimationFrame(flushFrameRef.current);
    }
  }, []);

  useEffect(() => {
    function closeOpenPanel(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      setContextOpen(false);
      setHistoryOpen(false);
    }
    window.addEventListener("keydown", closeOpenPanel);
    return () => window.removeEventListener("keydown", closeOpenPanel);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeSession?.messages, loading]);

  function createNewSession() {
    if (!library) {
      return;
    }
    const next = makeSession([], library.papers);
    setSessions((current) => {
      const sessionsNext = [next, ...current];
      persistSessions(sessionsNext);
      return sessionsNext;
    });
    setActiveId(next.id);
    setInput("");
    setHistoryOpen(false);
    setContextOpen(true);
  }

  function removeSession(sessionId: string) {
    setSessions((current) => {
      let next = current.filter((session) => session.id !== sessionId);
      if (!next.length && library) {
        next = [makeSession([], library.papers)];
      }
      if (activeId === sessionId) {
        setActiveId(next[0]?.id || "");
      }
      persistSessions(next);
      return next;
    });
  }

  function confirmRemoveSession(session: ChatSession) {
    if (window.confirm(`Delete “${session.title}”? This discussion and its messages cannot be recovered.`)) {
      removeSession(session.id);
    }
  }

  function togglePaper(paperId: string) {
    if (!activeSession || !library) {
      return;
    }
    updateSession(activeSession.id, (session) => {
      const paperIds = session.paperIds.includes(paperId)
        ? session.paperIds.filter((id) => id !== paperId)
        : [...session.paperIds, paperId].slice(-8);
      const papers = library.papers.filter((paper) => paperIds.includes(paper.id));
      return {
        ...session,
        paperIds,
        title: session.titleMode === "auto" ? automaticTitle(papers) : session.title,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const content = input.trim();
    if (!content || loading || !activeSession || !selectedPapers.length) {
      return;
    }
    const sessionId = activeSession.id;
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content };
    const nextMessages = [...activeSession.messages, userMessage];
    const requestPapers = [...selectedPapers];
    const assistantId = crypto.randomUUID();
    updateSession(sessionId, (session) => ({ ...session, messages: nextMessages, updatedAt: new Date().toISOString() }));
    setInput("");
    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    // Accumulate locally so we don't rebuild the whole message array from a stale
    // closure on every token. React state updates every token (cheap), but the
    // localStorage write is coalesced to one per animation frame — serializing
    // the whole session list on every token was the streaming hot-path cost.
    let assistantContent = "";
    let grounding: ChatMessage["grounding"];
    let started = false;
    const applyAssistant = (session: ChatSession): ChatSession => {
      const withoutDraft = session.messages.filter((message) => message.id !== assistantId);
      return {
        ...session,
        messages: [...withoutDraft, { id: assistantId, role: "assistant", content: assistantContent, grounding }],
        updatedAt: new Date().toISOString(),
      };
    };
    const writeAssistant = (persist = false) => {
      setSessions((current) => {
        const next = current
          .map((session) => (session.id === sessionId ? applyAssistant(session) : session))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        if (persist) {
          if (flushFrameRef.current !== null) {
            cancelAnimationFrame(flushFrameRef.current);
            flushFrameRef.current = null;
          }
          persistSessions(next);
        } else if (flushFrameRef.current === null) {
          // Coalesce writes: persist the latest committed state next frame.
          flushFrameRef.current = requestAnimationFrame(() => {
            flushFrameRef.current = null;
            setSessions((latest) => {
              persistSessions(latest);
              return latest;
            });
          });
        }
        return next;
      });
    };
    const requestBody = JSON.stringify({
      messages: nextMessages.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
      pdfStartPage: activeSession.pdfStartPage,
      ...(activeSession.pdfEndPage == null ? {} : { pdfEndPage: activeSession.pdfEndPage }),
      papers: requestPapers.map((paper) => ({
        title: paper.title,
        abstract: paper.abstract,
        summary: paper.summary,
        notes: paper.notes,
        authors: paper.authors.map((author) => author.displayName),
        venue: venue(paper),
        year: paper.year,
        pdfUrl: paper.pdfViewUrl,
        htmlUrl: paper.htmlUrl,
      })),
    });

    // Buffered fallback for environments (preview proxies, some hosts) that
    // cannot forward a streaming response — the browser reports those as a bare
    // "Failed to fetch". We ask for a single JSON reply and render it at once.
    const runBuffered = async () => {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        signal: controller.signal,
        body: requestBody,
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await response.json() as { content?: string; grounding?: ChatMessage["grounding"] };
      grounding = payload.grounding;
      assistantContent = payload.content || "I could not produce a response for that question.";
      writeAssistant(true);
    };

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        signal: controller.signal,
        body: requestBody,
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      if (!response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        // The server (or a proxy) did not return a stream — read it as buffered JSON.
        const payload = await response.json().catch(() => null) as { content?: string; grounding?: ChatMessage["grounding"] } | null;
        grounding = payload?.grounding;
        assistantContent = payload?.content || "I could not produce a response for that question.";
        writeAssistant(true);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(0), { stream: !done });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          let eventName = "message";
          let dataLine = "";
          for (const line of rawEvent.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          const payload = JSON.parse(dataLine) as {
            text?: string;
            grounding?: ChatMessage["grounding"];
            message?: string;
          };
          if (eventName === "meta") {
            grounding = payload.grounding;
          } else if (eventName === "delta" && payload.text) {
            assistantContent += payload.text;
            if (!started) { started = true; }
            writeAssistant();
          } else if (eventName === "error") {
            throw new Error(payload.message || "The assistant request failed.");
          }
        }
        if (done) break;
      }
      if (!assistantContent) {
        assistantContent = "I could not produce a response for that question.";
      }
      writeAssistant(true);
    } catch (error) {
      if (controller.signal.aborted) {
        // User stopped generation: keep whatever text streamed in, with a marker.
        assistantContent = assistantContent ? `${assistantContent}\n\n_(stopped)_` : "_(stopped)_";
        writeAssistant(true);
      } else if (!started && (error instanceof TypeError || (error instanceof Error && /fetch/i.test(error.message)))) {
        // The streaming request never delivered a token (likely a proxy that
        // can't forward event-streams). Retry once in buffered mode before
        // surfacing an error to the user.
        try {
          await runBuffered();
        } catch (fallbackError) {
          if (!controller.signal.aborted) {
            assistantContent = fallbackError instanceof Error ? `I couldn’t complete that request: ${fallbackError.message}` : "I couldn’t complete that request.";
            grounding = undefined;
            writeAssistant(true);
          }
        }
      } else {
        // Mid-stream failure after some text arrived: keep the partial answer and
        // its grounding receipt, and append the error rather than discarding both.
        const detail = error instanceof Error ? error.message : "The assistant request failed.";
        assistantContent = assistantContent
          ? `${assistantContent}\n\n_(interrupted: ${detail})_`
          : `I couldn’t complete that request: ${detail}`;
        writeAssistant(true);
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }

  function stopGeneration() {
    abortRef.current?.abort();
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function beginTitleEdit() {
    if (!activeSession) {
      return;
    }
    setTitleDraft(activeSession.title);
    setTitleEditing(true);
  }

  function cancelTitleEdit() {
    setTitleDraft(activeSession?.title || "");
    setTitleEditing(false);
  }

  function commitTitleEdit() {
    if (!activeSession) {
      return;
    }
    const nextTitle = titleDraft.trim() || automaticTitle(selectedPapers);
    updateSession(activeSession.id, (session) => ({
      ...session,
      title: nextTitle,
      titleMode: titleDraft.trim() ? "custom" : "auto",
      updatedAt: new Date().toISOString(),
    }));
    setTitleEditing(false);
  }

  if (!ready) {
    return <main className="chat-workspace-loading"><span className="assistant-orb"><Sparkles size={18} /></span><p>Opening your discussions…</p></main>;
  }

  if (!library || !activeSession) {
    return <main className="chat-workspace-loading"><p>Paper Assistant could not load the local library.</p><Link href="/"><Home size={16} /> Return to library</Link></main>;
  }

  return (
    <main className={`chat-workspace-page ${historyOpen ? "history-is-open" : ""} ${contextOpen ? "context-is-open" : ""}`}>
      <aside className="chat-history-panel">
        <header>
          <Link href="/" aria-label="Return to Paper Assistant"><span className="brand-mark compact">PA</span><span><strong>Paper Assistant</strong><small>Chat history</small></span></Link>
          <ActionButton variant="ghost" size="icon" className="chat-history-close" onClick={() => setHistoryOpen(false)} aria-label="Close chat history" icon={<PanelLeftClose />} />
        </header>
        <ActionButton variant="primary" className="my-3 w-full" onClick={createNewSession} icon={<MessageSquarePlus />}>New discussion</ActionButton>
        <div className="chat-session-list">
          {sessions.map((session) => (
            <article className={session.id === activeSession.id ? "is-active" : ""} key={session.id}>
              <button type="button" onClick={() => setActiveId(session.id)}>
                <strong>{session.title}</strong>
                <span>{session.paperIds.length} {session.paperIds.length === 1 ? "paper" : "papers"} · {sessionTimestamp(session.updatedAt)}</span>
              </button>
              <ActionButton variant="danger" size="icon-small" className="session-delete" onClick={() => confirmRemoveSession(session)} aria-label={`Delete ${session.title}`} icon={<Trash2 />} />
            </article>
          ))}
        </div>
      </aside>

      <section className="chat-workspace-main">
        <header className="chat-workspace-header">
          <ActionButton variant="secondary" size="icon-large" className="history-open-button" onClick={() => setHistoryOpen((current) => !current)} aria-label={historyOpen ? "Collapse chat history" : "Open chat history"} icon={<Menu />} />
          {titleEditing ? (
            <div className="chat-title-editing">
              <label className="chat-title-field">
                <span className="sr-only">Discussion title</span>
                <input
                  autoFocus
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitTitleEdit();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelTitleEdit();
                    }
                  }}
                />
              </label>
              <ActionButton variant="primary" size="icon-large" onClick={commitTitleEdit} aria-label="Save discussion title" title="Save title" icon={<Check />} />
              <ActionButton variant="secondary" size="icon-large" onClick={cancelTitleEdit} aria-label="Cancel title edit" title="Cancel" icon={<X />} />
            </div>
          ) : (
            <div className="chat-title-summary">
              <strong>{activeSession.title}</strong>
              <small>{selectedPapers.length} {selectedPapers.length === 1 ? "paper" : "papers"} in context</small>
            </div>
          )}
          {!titleEditing ? (
            <ActionButton variant="secondary" size="large" onClick={beginTitleEdit} aria-label="Rename discussion" title="Rename discussion" icon={<Pencil />}>Rename</ActionButton>
          ) : null}
          <ActionButton variant="secondary" size="large" className="context-toggle" onClick={() => setContextOpen((current) => !current)} aria-label={contextOpen ? "Collapse paper context" : "Open paper context"} title="Paper context" icon={<PanelRight />}>Papers</ActionButton>
        </header>

        <div className="chat-workspace-messages">
          {!activeSession.messages.length ? (
            <div className="chat-empty-state">
              <span className="message-avatar"><Sparkles size={26} /></span>
              <div><h1>{selectedPapers.length > 1 ? "Compare your selected papers" : "Start a grounded discussion"}</h1><p>{welcomeMessage(selectedPapers)}</p></div>
            </div>
          ) : null}
          {activeSession.messages.map((message) => (
            <div className={`chat-workspace-message message-${message.role}`} key={message.id}>
              {message.role === "assistant" ? <span className="message-avatar"><Sparkles size={26} /></span> : null}
              <div className="chat-workspace-bubble-wrap">
                {message.content
                  ? <MarkdownContent content={message.content} className="chat-workspace-bubble" />
                  : <div className="typing chat-workspace-typing" role="status" aria-label="Paper Assistant is responding"><i /><i /><i /></div>}
                {message.role === "assistant" ? <GroundingReceipt grounding={message.grounding} /> : null}
              </div>
            </div>
          ))}
          {loading && activeSession.messages[activeSession.messages.length - 1]?.role !== "assistant" ? (
            <div className="chat-workspace-message message-assistant">
              <span className="message-avatar"><Sparkles size={26} /></span>
              <div className="typing chat-workspace-typing" role="status" aria-label="Paper Assistant is responding">
                <i />
                <i />
                <i />
              </div>
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>

        <div className="chat-workspace-footer">
          <div className="chat-workspace-prompts">
            {["Summarize the contribution", "Challenge the methods", "Connect to my notes"].map((prompt) => <Chip tone="neutral" onClick={() => setInput(prompt)} key={prompt}>{prompt}</Chip>)}
          </div>
          <form className="chat-workspace-composer" onSubmit={sendMessage}>
            <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onComposerKeyDown} placeholder={selectedPapers.length ? "Ask about the selected papers…" : "Select at least one paper to begin…"} rows={2} disabled={!selectedPapers.length} />
            {loading
              ? <ActionButton type="button" variant="secondary" size="icon" className="h-auto w-auto self-stretch" onClick={stopGeneration} aria-label="Stop generating" title="Stop generating" icon={<Square />} />
              : <ActionButton type="submit" variant="primary" size="icon" className="h-auto w-auto self-stretch" disabled={!input.trim() || !selectedPapers.length} aria-label="Send message" icon={<Send />} />}
            <small>Enter to send · Shift + Enter for a new line</small>
          </form>
        </div>
      </section>

      <aside className="chat-context-panel">
        <header>
          <span><strong>Paper context</strong><small>Choose up to eight papers</small></span>
          <ActionButton variant="ghost" size="icon" className="chat-context-close" onClick={() => setContextOpen(false)} aria-label="Close paper context" icon={<PanelRightClose />} />
        </header>
        <label className="chat-context-search"><Search size={15} /><input value={paperQuery} onChange={(event) => setPaperQuery(event.target.value)} placeholder="Search your library" /></label>
        <div className="chat-context-list">
          {filteredPapers.map((paper) => {
            const selected = activeSession.paperIds.includes(paper.id);
            return (
              <button type="button" className={selected ? "is-selected" : ""} onClick={() => togglePaper(paper.id)} key={paper.id}>
                <span className="selection-box">{selected ? <Check size={12} /> : null}</span>
                <span><strong>{paper.title}</strong><small>{authors(paper)} · {venue(paper)} {paper.year || ""}</small></span>
              </button>
            );
          })}
        </div>
        <footer>
          <span><FileText size={14} /> {selectedPapers.length} of 8 selected</span>
          <label className="chat-grounding-pages">
            <span>PDF pages</span>
            <input
              type="number"
              min="1"
              max="20"
              value={activeSession.pdfStartPage}
              aria-label="First PDF page attached to chat"
              onChange={(event) => {
                const start = Math.min(20, Math.max(1, Number(event.target.value) || 1));
                updateSession(activeSession.id, (session) => ({
                  ...session,
                  pdfStartPage: start,
                  pdfEndPage: session.pdfEndPage == null ? null : Math.max(start, session.pdfEndPage),
                }));
              }}
            />
            <i>to</i>
            <input
              type="number"
              min={activeSession.pdfStartPage}
              max="20"
              value={activeSession.pdfEndPage ?? ""}
              placeholder="Default"
              aria-label="Last PDF page attached to chat"
              onChange={(event) => {
                const end = event.target.value === "" ? null : Math.min(20, Math.max(activeSession.pdfStartPage, Number(event.target.value) || activeSession.pdfStartPage));
                updateSession(activeSession.id, (session) => ({ ...session, pdfEndPage: end }));
              }}
            />
          </label>
        </footer>
      </aside>
    </main>
  );
}
