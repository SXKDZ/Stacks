"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Author } from "@/app/lib/types";

type AuthorEntry = Pick<Author, "id" | "displayName">;

function useAdaptiveAuthorLine(authors: AuthorEntry[]): {
  containerRef: RefObject<HTMLSpanElement | null>;
  measurementRef: RefObject<HTMLSpanElement | null>;
  visibleCount: number;
} {
  const [visibleCount, setVisibleCount] = useState(authors.length);
  const containerRef = useRef<HTMLSpanElement>(null);
  const measurementRef = useRef<HTMLSpanElement>(null);
  const authorSignature = authors.map((author) => `${author.id}:${author.displayName}`).join("\u0000");

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measurement = measurementRef.current;
    if (!container || !measurement) return;

    let active = true;
    let measureFrame = 0;
    const measure = () => {
      measureFrame = 0;
      if (!active) return;

      // Candidate widths come from hidden text rendered in this exact byline,
      // with its inherited font and disclosure styles. Compare integer pixels
      // conservatively so a fractional glyph can never cross the clip edge.
      const availableWidth = Math.max(0, Math.floor(container.getBoundingClientRect().width));
      const nameWidths = Array.from(
        measurement.querySelectorAll<HTMLElement>("[data-author-measure-name]"),
        (node) => node.getBoundingClientRect().width,
      );
      const separatorWidth = measurement.querySelector<HTMLElement>("[data-author-measure-separator]")?.getBoundingClientRect().width ?? 0;
      let nextVisibleCount = 0;
      let namesWidth = 0;
      for (let count = 0; count <= nameWidths.length; count += 1) {
        if (count > 0) namesWidth += nameWidths[count - 1] + (count > 1 ? separatorWidth : 0);
        if (count === nameWidths.length) {
          if (Math.ceil(namesWidth) <= availableWidth) nextVisibleCount = count;
          continue;
        }
        const hiddenCount = nameWidths.length - count;
        const toggle = measurement.querySelector<HTMLElement>(`[data-author-toggle-count="${hiddenCount}"]`);
        const toggleStyle = toggle ? window.getComputedStyle(toggle) : null;
        const toggleWidth = toggle
          ? toggle.getBoundingClientRect().width
            + Number.parseFloat(toggleStyle?.marginInlineStart || "0")
            + Number.parseFloat(toggleStyle?.marginInlineEnd || "0")
          : 0;
        const requiredWidth = namesWidth + toggleWidth;
        // Scan every candidate because the disclosure can shrink when its count
        // changes digits. Commit once, so dragging never oscillates through a
        // sequence of intermediate author counts.
        if (toggle && Math.ceil(requiredWidth) <= availableWidth) nextVisibleCount = count;
      }
      setVisibleCount((current) => current === nextVisibleCount ? current : nextVisibleCount);
    };
    const requestMeasure = () => {
      window.cancelAnimationFrame(measureFrame);
      measureFrame = window.requestAnimationFrame(measure);
    };

    requestMeasure();
    const resizeObserver = new ResizeObserver(requestMeasure);
    resizeObserver.observe(container);
    // Observe the layout owners as well as the byline. Table and reader resizes
    // can update an ancestor first; every callback is folded into one frame.
    if (container.parentElement) resizeObserver.observe(container.parentElement);
    const cell = container.closest("td");
    if (cell) resizeObserver.observe(cell);
    window.addEventListener("stacks:resize-end", requestMeasure);
    void document.fonts?.ready.then(requestMeasure);
    return () => {
      active = false;
      window.cancelAnimationFrame(measureFrame);
      resizeObserver.disconnect();
      window.removeEventListener("stacks:resize-end", requestMeasure);
    };
  }, [authorSignature, authors.length]);

  return { containerRef, measurementRef, visibleCount };
}

function AuthorMeasurement({ authors, measurementRef }: {
  authors: AuthorEntry[];
  measurementRef: RefObject<HTMLSpanElement | null>;
}) {
  return (
    <span ref={measurementRef} className="author-adaptive-measure" aria-hidden="true">
      {authors.map((author) => <span key={author.id} data-author-measure-name>{author.displayName}</span>)}
      {/* Non-breaking space, exactly as the byline renders it: a plain trailing
          space would be trimmed here as end-of-line white space and the fitter
          would then buy one space of width per visible author. */}
      <span data-author-measure-separator>{", "}</span>
      {authors.map((_, index) => {
        const count = authors.length - index;
        // Carries the live disclosure class so each candidate is measured with
        // the same font, weight, and inline margin the control will render at.
        return <span key={count} className="author-toggle author-toggle-measure" data-author-toggle-count={count}>{count} more {count === 1 ? "author" : "authors"}</span>;
      })}
    </span>
  );
}

/**
 * One byline for every surface: the reader header, the paper rows, the detail
 * header, and the compact meta lines. Names are plain text unless onOpenAuthor is
 * given, in which case each is a link to its author. The disclosure control is the
 * same element in both states, so it cannot pick up a style the hidden measurement
 * does not see: that mismatch is what clipped the reader's "N more authors".
 */
export function AdaptiveAuthors({ authors, onOpenAuthor, showAll = false, emptyLabel = "No authors recorded" }: {
  authors: AuthorEntry[];
  onOpenAuthor?: (authorName: string) => void;
  showAll?: boolean;
  emptyLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { containerRef, measurementRef, visibleCount } = useAdaptiveAuthorLine(authors);
  const isExpanded = showAll || expanded;
  const visibleAuthors = isExpanded ? authors : authors.slice(0, visibleCount);
  const hiddenCount = Math.max(0, authors.length - visibleAuthors.length);

  if (!authors.length) {
    return <span className="expandable-author-list is-empty">{emptyLabel}</span>;
  }

  const classes = ["expandable-author-list", "is-adaptive-single-line"];
  if (onOpenAuthor) classes.push("is-linked");
  if (isExpanded) classes.push("is-expanded");
  if (showAll) classes.push("shows-all");

  return (
    <span ref={containerRef} className={classes.join(" ")}>
      <span className="adaptive-author-name-run">
        {visibleAuthors.map((author, index) => (
          <span key={author.id}>
            {onOpenAuthor
              ? <button type="button" onClick={(event) => { event.stopPropagation(); onOpenAuthor(author.displayName); }}>{author.displayName}</button>
              : author.displayName}
            {index < visibleAuthors.length - 1 ? ", " : ""}
          </span>
        ))}
        {/* Last child of the name run in both states, so the control stays on the
            byline's line and is styled by one rule the measurement mirrors. */}
        {showAll ? null : isExpanded ? (
          <button
            type="button"
            className="author-toggle"
            aria-expanded="true"
            onClick={(event) => { event.stopPropagation(); setExpanded(false); }}
          >
            Show fewer authors
          </button>
        ) : hiddenCount ? (
          <button
            type="button"
            className="author-toggle"
            aria-expanded="false"
            onClick={(event) => { event.stopPropagation(); setExpanded(true); }}
          >
            {`${hiddenCount} more ${hiddenCount === 1 ? "author" : "authors"}`}
          </button>
        ) : null}
      </span>
      {showAll ? null : <AuthorMeasurement authors={authors} measurementRef={measurementRef} />}
    </span>
  );
}
