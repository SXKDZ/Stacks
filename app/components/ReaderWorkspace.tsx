"use client";

import {
  ExternalLink,
  FileText,
  Library,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { ActionButton, ActionLink, StatusPill } from "@/app/components/ui/controls";
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
      url: `/pa-files/html/${encodeURIComponent(paper.htmlSnapshotPath)}`,
      isHtml: true,
    };
  }
  if (paper.localPath && !isRemoteLocation(paper.localPath)) {
    return {
      kind: "Local PDF",
      value: paper.localPath,
      url: `/pa-files/pdfs/${encodeURIComponent(paper.localPath)}`,
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

async function responseMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || `Request failed with status ${response.status}.`;
  } catch {
    return `Request failed with status ${response.status}.`;
  }
}

function ReaderAuthors({ paper }: { paper: Paper }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? paper.authors : paper.authors.slice(0, 5);
  const hiddenCount = Math.max(0, paper.authors.length - visible.length);

  return (
    <span className="reader-author-line">
      {visible.map((author) => author.displayName).join(", ") || "Authors unavailable"}
      {hiddenCount > 0 ? ", " : " "}
      {hiddenCount > 0 ? (
        <button type="button" onClick={() => setExpanded(true)}>{hiddenCount} more {hiddenCount === 1 ? "author" : "authors"}</button>
      ) : paper.authors.length > 5 ? (
        <button type="button" onClick={() => setExpanded(false)}>Show fewer</button>
      ) : null}
    </span>
  );
}

export default function ReaderWorkspace() {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    let active = true;
    async function loadPaper() {
      const paperId = new URLSearchParams(window.location.search).get("paper");
      if (!paperId) {
        setError("No paper was selected for the reader.");
        setLoading(false);
        return;
      }
      try {
        const response = await fetch("/api/library", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(await responseMessage(response));
        }
        const snapshot = (await response.json()) as LibrarySnapshot;
        const selected = snapshot.papers.find((candidate) => candidate.id === paperId);
        if (!selected) {
          throw new Error("The selected paper is no longer in the library.");
        }
        if (active) {
          setPaper(selected);
          document.title = `${selected.title} — Reader`;
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
        throw new Error(await responseMessage(response));
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
      <main className="reader-layer reader-page reader-page-state">
        <LoaderCircle className="spin" size={28} />
        <p>Opening document…</p>
      </main>
    );
  }

  if (!paper || !documentSource) {
    return (
      <main className="reader-layer reader-page reader-page-state">
        <FileText size={28} />
        <h1>Reader unavailable</h1>
        <p>{error || "The document could not be opened."}</p>
        <Link href="/"><Library size={16} /> Return to library</Link>
      </main>
    );
  }

  return (
    <main className="reader-layer reader-page">
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
          <ActionButton variant="on-dark" size="small" onClick={() => window.open(`/chat?paper=${encodeURIComponent(paper.id)}`, "_blank", "noopener,noreferrer")} icon={<Sparkles />}>Ask PA</ActionButton>
          {paper.url ? <ActionLink variant="on-dark" size="small" href={paper.url} target="_blank" rel="noreferrer" icon={<ExternalLink />}>Source</ActionLink> : null}
          <ActionLink variant="on-dark" size="small" href="/" icon={<Library />}>Library</ActionLink>
        </div>
      </header>
      <div className="reader-workspace">
        <section className="reader-document" aria-label={`${documentSource.kind}: ${documentSource.value}`}>
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
              <p>Add a local PDF or HTML snapshot from the paper editor.</p>
            </div>
          )}
        </section>
        <aside className="reader-notes">
          <div className="reader-paper-meta">
            <StatusPill className="reader-paper-status" status={paper.readingStatus} />
            <span>{venueLabel(paper)}</span>
            <span>{paper.year ?? "n.d."}</span>
          </div>
          <h2>{paper.title}</h2>
          <p className="reader-authors"><ReaderAuthors paper={paper} /></p>
          <section className="reader-summary reader-summary-scroll">
            <p className="eyebrow">Summary</p>
            <MarkdownContent content={paper.summary || paper.abstract || "No summary is available for this paper yet."} />
          </section>
          <section className="reader-summary reader-notes-section">
            <div className="reader-section-heading">
              <p className="eyebrow">My notes</p>
              <span aria-live="polite">{noteState === "saving" ? "Saving…" : noteState === "saved" ? "Saved" : noteState === "error" ? "Save failed" : ""}</span>
            </div>
            <textarea
              key={`${paper.id}:${paper.updatedAt}`}
              className="reader-notes-editor"
              defaultValue={paper.notes}
              placeholder="Add an observation, question, or connection…"
              aria-label="My notes"
              onFocus={() => setNoteState("idle")}
              onBlur={(event) => void saveNotes(event.target.value)}
            />
          </section>
          <ActionButton variant="primary" className="mt-5 w-full" onClick={() => window.open(`/chat?paper=${encodeURIComponent(paper.id)}`, "_blank", "noopener,noreferrer")} icon={<Sparkles />}>Discuss this paper with PA</ActionButton>
        </aside>
      </div>
    </main>
  );
}
