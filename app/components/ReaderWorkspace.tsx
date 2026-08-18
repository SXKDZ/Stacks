"use client";

import {
  ExternalLink,
  FileText,
  Library,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { AdaptiveAuthorNames } from "@/app/components/ui/AdaptiveAuthors";
import { MarkdownCodeEditor } from "@/app/components/ui/MarkdownCodeEditor";
import { ActionButton, ActionLink, StatusPill } from "@/app/components/ui/controls";
import { readError } from "@/app/lib/http";
import { beginPointerResize } from "@/app/lib/pointer-resize";
import type { LibrarySnapshot, Paper } from "@/app/lib/types";

function venueLabel(paper: Paper): string {
  return paper.venueAcronym || paper.venueName || (paper.paperType === "preprint" ? "arXiv" : "No venue");
}

function isRemoteLocation(value: string | null | undefined): boolean {
  return /^https?:\/\//i.test(value?.trim() ?? "");
}

function documentIdentity(paper: Paper): { kind: string; value: string; url: string | null; isHtml: boolean } {
  if (paper.htmlSnapshotPath && !isRemoteLocation(paper.htmlSnapshotPath)) {
    return {
      kind: "Local HTML snapshot",
      value: paper.htmlSnapshotPath,
      url: `/stacks-files/html/${encodeURIComponent(paper.htmlSnapshotPath)}`,
      isHtml: true,
    };
  }
  if (paper.localPath && !isRemoteLocation(paper.localPath)) {
    return {
      kind: "Local PDF",
      value: paper.localPath,
      url: `/stacks-files/pdfs/${encodeURIComponent(paper.localPath)}`,
      isHtml: false,
    };
  }
  if (paper.htmlUrl) {
    return {
      kind: "HTML source",
      value: paper.htmlUrl,
      url: paper.htmlUrl,
      isHtml: true,
    };
  }
  if (paper.pdfViewUrl) {
    return {
      kind: "PDF source",
      value: paper.pdfViewUrl,
      url: paper.pdfViewUrl,
      isHtml: false,
    };
  }
  const sourceUrl = paper.url || (isRemoteLocation(paper.localPath) ? paper.localPath : null);
  if (sourceUrl) {
    const isPdf = /(?:\.pdf)(?:$|[?#])/i.test(sourceUrl) || /\/pdf\//i.test(sourceUrl);
    return {
      kind: isPdf ? "PDF source" : "Source page",
      value: sourceUrl,
      url: sourceUrl,
      isHtml: !isPdf,
    };
  }
  return {
    kind: "No document attached",
    value: paper.title,
    url: null,
    isHtml: false,
  };
}


const READER_SIDEBAR_KEY = "stacks-reader-sidebar-width";
const READER_SIDEBAR_DEFAULT = 330;
const READER_SIDEBAR_MIN = 280;
const READER_SIDEBAR_MAX = 720;

export default function ReaderWorkspace() {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [notesDraft, setNotesDraft] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(READER_SIDEBAR_DEFAULT);

  useEffect(() => {
    const saved = Number(window.localStorage.getItem(READER_SIDEBAR_KEY));
    if (saved < READER_SIDEBAR_MIN || saved > READER_SIDEBAR_MAX) return;
    const frame = window.requestAnimationFrame(() => setSidebarWidth(saved));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function storeSidebarWidth(width: number) {
    const next = Math.min(READER_SIDEBAR_MAX, Math.max(READER_SIDEBAR_MIN, width));
    setSidebarWidth(next);
    window.localStorage.setItem(READER_SIDEBAR_KEY, String(next));
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    beginPointerResize(event.pointerId, (clientX) => {
      setSidebarWidth(Math.min(READER_SIDEBAR_MAX, Math.max(READER_SIDEBAR_MIN, startWidth + startX - clientX)));
    }, () => {
      setSidebarWidth((width) => {
        window.localStorage.setItem(READER_SIDEBAR_KEY, String(width));
        return width;
      });
    });
  }

  function resizeSidebarWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      storeSidebarWidth(sidebarWidth + 16);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      storeSidebarWidth(sidebarWidth - 16);
    } else if (event.key === "Home") {
      event.preventDefault();
      storeSidebarWidth(READER_SIDEBAR_MIN);
    } else if (event.key === "End") {
      event.preventDefault();
      storeSidebarWidth(READER_SIDEBAR_MAX);
    }
  }

  useEffect(() => {
    let active = true;
    async function loadPaper() {
      const paperId = new URLSearchParams(window.location.search).get("paper");
      if (!paperId) {
        setError("No paper was selected.");
        setLoading(false);
        return;
      }
      try {
        const response = await fetch("/api/library", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
        const snapshot = (await response.json()) as LibrarySnapshot;
        const selected = snapshot.papers.find((candidate) => candidate.id === paperId);
        if (!selected) {
          throw new Error("The selected paper is no longer in the library.");
        }
        if (active) {
          setPaper(selected);
          document.title = `${selected.title} · Reader`;
        }
      } catch (nextError) {
        if (active) {
          setError(nextError instanceof Error ? nextError.message : "The paper could not be opened.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
    void loadPaper();
    return () => {
      active = false;
    };
  }, []);

  const documentSource = useMemo(() => paper ? documentIdentity(paper) : null, [paper]);

  // Keep the notes editor in sync with the loaded/saved paper.
  useEffect(() => { setNotesDraft(paper?.notes ?? ""); }, [paper?.id, paper?.updatedAt, paper?.notes]);

  async function saveNotes(notes: string) {
    if (!paper || notes === paper.notes) {
      return;
    }
    setNoteState("saving");
    try {
      const response = await fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: "paper", action: "update", id: paper.id, data: { notes } }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const snapshot = (await response.json()) as LibrarySnapshot;
      setPaper(snapshot.papers.find((candidate) => candidate.id === paper.id) ?? { ...paper, notes });
      setNoteState("saved");
    } catch {
      setNoteState("error");
    }
  }

  if (loading) {
    return (
      <main className="reader-layer reader-page reader-page-state workspace-enter app-interaction-scope">
        <LoaderCircle className="spin" size={28} />
        <p>Opening document…</p>
      </main>
    );
  }

  if (!paper || !documentSource) {
    return (
      <main className="reader-layer reader-page reader-page-state workspace-enter app-interaction-scope">
        <FileText size={28} />
        <h1>Reader unavailable</h1>
        <p>{error || "The document could not be opened."}</p>
        <Link href="/"><Library size={16} /> Return to library</Link>
      </main>
    );
  }

  return (
    <main className="reader-layer reader-page workspace-enter app-interaction-scope">
      <header className="reader-header">
        <div className="reader-brand">
          <Link className="brand-logo-link" href="/" aria-label="Return to Stacks"><img src="/favicon.svg" alt="" className="brand-logo compact" width={30} height={30} /></Link>
          <span className="reader-file-identity">
            <small>{documentSource.kind}</small>
            <strong title={documentSource.value}>{documentSource.value}</strong>
            <span title={paper.title}>{paper.title}</span>
          </span>
        </div>
        <div className="reader-actions">
          <ActionButton variant="on-dark" size="small" onClick={() => window.open(`/feed?paper=${encodeURIComponent(paper.id)}`, "_blank", "noopener,noreferrer")} icon={<Sparkles />}>Discuss in feed</ActionButton>
          {paper.url ? <ActionLink variant="on-dark" size="small" href={paper.url} target="_blank" rel="noreferrer" icon={<ExternalLink />}>Source</ActionLink> : null}
          <ActionLink variant="on-dark" size="small" href="/" icon={<Library />}>Library</ActionLink>
        </div>
      </header>
      <div className="reader-workspace" style={{ "--reader-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
        <section
          className="reader-document"
          aria-label={`${documentSource.kind}: ${documentSource.value}`}
          data-tooltip-disabled
        >
          {documentSource.url ? (
            documentSource.isHtml ? (
              <iframe src={documentSource.url} title={`${documentSource.kind}: ${documentSource.value}`} sandbox="" />
            ) : (
              <iframe src={documentSource.url} title={`${documentSource.kind}: ${documentSource.value}`} />
            )
          ) : (
            <div className="reader-empty-document">
              <FileText size={30} />
              <h2>No document attached</h2>
              <p>Add a PDF or saved web page from the paper editor.</p>
            </div>
          )}
        </section>
        <div
          className="reader-sidebar-resize"
          role="separator"
          aria-label="Resize paper information sidebar"
          aria-orientation="vertical"
          aria-valuemin={READER_SIDEBAR_MIN}
          aria-valuemax={READER_SIDEBAR_MAX}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={startSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
          onDoubleClick={() => storeSidebarWidth(READER_SIDEBAR_DEFAULT)}
        />
        <aside className="reader-notes">
          <div className="reader-paper-meta">
            <StatusPill className="reader-paper-status" status={paper.readingStatus} />
            <span>{venueLabel(paper)}</span>
            <span>{paper.year ?? "n.d."}</span>
          </div>
          <h2>{paper.title}</h2>
          <p className="reader-authors"><AdaptiveAuthorNames authors={paper.authors} emptyLabel="Authors unavailable" /></p>
          <section className="reader-summary reader-summary-scroll">
            <p className="eyebrow">Summary</p>
            <MarkdownContent content={paper.summary || paper.abstract || "No summary yet."} />
          </section>
          <section className="reader-summary reader-notes-section">
            <div className="reader-section-heading">
              <p className="eyebrow">My notes</p>
              <span aria-live="polite">{noteState === "saving" ? "Saving…" : noteState === "saved" ? "Saved" : noteState === "error" ? "Save failed" : ""}</span>
            </div>
            <MarkdownCodeEditor
              value={notesDraft}
              onChange={(value) => { setNotesDraft(value); setNoteState("idle"); }}
              onBlur={() => void saveNotes(notesDraft)}
              rows={8}
              ariaLabel="My notes"
              placeholder="Add a note…"
            />
          </section>
          <ActionButton variant="primary" className="mt-5 w-full" onClick={() => window.open(`/feed?paper=${encodeURIComponent(paper.id)}`, "_blank", "noopener,noreferrer")} icon={<Sparkles />}>Discuss this paper in the feed</ActionButton>
        </aside>
      </div>
    </main>
  );
}
