"use client";

import { Bot, ChevronRight, FileDiff, ListTree, PanelRightClose, Terminal, Workflow as WorkflowIcon } from "lucide-react";
import { useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { FeedOutlineEntry, FeedOutlineOperation } from "@/app/lib/feed-tool-view";

/** The same glyphs the thread's cards use, so a rail entry and its card match. */
function operationGlyph(kind: FeedOutlineOperation["kind"]): ReactNode {
  if (kind === "diff") return <FileDiff size={12} aria-hidden="true" />;
  if (kind === "subagent") return <Bot size={12} aria-hidden="true" />;
  if (kind === "workflow") return <WorkflowIcon size={12} aria-hidden="true" />;
  return <Terminal size={12} aria-hidden="true" />;
}

/**
 * A rail down the side of a thread: every turn, and the consequential steps inside it.
 *
 * Two things it answers. Where a long conversation got to — a thread of a thousand
 * turns is not navigable by scrolling alone, and the rail jumps to any of them. And
 * what the agent actually changed: the edits with their line counts, the agents it
 * spawned, the commands it left running, the workflows it started. File reads and
 * foreground commands are left out on purpose; one turn can hold ninety of them.
 *
 * A turn's steps stay folded until it is the turn being read or the reader opens it,
 * so a turn that made twenty edits is one row until it is asked about.
 */
export function FeedOutline({
  entries,
  activeId,
  stepsOnly,
  width,
  onStepsOnlyChange,
  onResizeStart,
  onJump,
  onClose,
}: {
  entries: FeedOutlineEntry[];
  /** The turn currently in view: highlighted, and unfolded. */
  activeId: string | null;
  /** Hide turns that changed nothing, for finding the handful that did. */
  stepsOnly: boolean;
  /** Its current width in pixels, dragged by the handle on its inner edge. */
  width: number;
  onStepsOnlyChange: (next: boolean) => void;
  onResizeStart: (event: ReactPointerEvent) => void;
  /** Scroll the thread to a turn, or to one operation inside it. */
  onJump: (interactionId: string, operationId?: string) => void;
  onClose: () => void;
}) {
  // What the reader has opened, and what they have folded away again. Two sets rather
  // than one, so "the turn being read is open" holds without overriding a deliberate
  // fold, and neither needs an effect to keep in step with the active turn.
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const isOpen = (id: string) => opened.has(id) || (id === activeId && !folded.has(id));

  function toggle(id: string) {
    const open = isOpen(id);
    setOpened((current) => {
      const next = new Set(current);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
    setFolded((current) => {
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const shown = stepsOnly ? entries.filter((entry) => entry.operations.length) : entries;
  const steps = entries.reduce((total, entry) => total + entry.operations.length, 0);
  return (
    <aside className="feed-outline" aria-label="Thread outline" style={{ width: `${width}px` }}>
      {/* A long path or a long request is what the rail is read for, so its width is
          the reader's to set. */}
      <div
        className="feed-outline-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the outline"
        onPointerDown={onResizeStart}
      />
      <header className="feed-outline-head">
        <ListTree size={13} aria-hidden="true" />
        <strong>Outline</strong>
        <button
          type="button"
          className={`feed-outline-filter ${stepsOnly ? "is-active" : ""}`}
          aria-pressed={stepsOnly}
          onClick={() => onStepsOnlyChange(!stepsOnly)}
          disabled={steps === 0}
        >
          {steps} {steps === 1 ? "step" : "steps"}
        </button>
        <button type="button" className="feed-outline-close" onClick={onClose} aria-label="Hide the outline">
          <PanelRightClose size={14} aria-hidden="true" />
        </button>
      </header>
      {shown.length === 0 ? (
        <p className="feed-outline-empty">Nothing was changed in this thread yet.</p>
      ) : (
        <ol className="feed-outline-list">
          {shown.map((entry) => {
            const open = isOpen(entry.id);
            return (
              <li key={entry.id}>
                <div className={`feed-outline-row ${entry.id === activeId ? "is-active" : ""}`}>
                  {entry.operations.length ? (
                    <button
                      type="button"
                      className={`feed-outline-fold ${open ? "is-open" : ""}`}
                      aria-expanded={open}
                      aria-label={open ? "Fold this turn's steps" : `Show this turn's ${entry.operations.length} steps`}
                      onClick={() => toggle(entry.id)}
                    >
                      <ChevronRight size={12} aria-hidden="true" />
                    </button>
                  ) : (
                    <span className="feed-outline-fold is-empty" aria-hidden="true" />
                  )}
                  <button type="button" className="feed-outline-turn" onClick={() => onJump(entry.id)} title={entry.label}>
                    {entry.label}
                  </button>
                  {entry.operations.length && !open ? (
                    <span className="feed-outline-turn-count">{entry.operations.length}</span>
                  ) : null}
                </div>
                {entry.operations.length && open ? (
                  <ul className="feed-outline-ops">
                    {entry.operations.map((operation) => (
                      <li key={operation.id}>
                        <button
                          type="button"
                          className="feed-outline-op"
                          onClick={() => onJump(entry.id, operation.id)}
                          title={[operation.heading.name, operation.heading.subject, operation.heading.stat].filter(Boolean).join(" · ")}
                        >
                          {operationGlyph(operation.kind)}
                          <span className="feed-outline-op-subject">{operation.heading.subject ?? operation.heading.name}</span>
                          {operation.heading.stat ? <span className="feed-outline-op-stat">{operation.heading.stat}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
