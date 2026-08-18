"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Author } from "@/app/lib/types";

type AuthorEntry = Pick<Author, "id" | "displayName">;

// Keep a small optical buffer so glyph anti-aliasing, underlines, and fractional
// table pixels never put the last letters directly against the clipping edge.
const AUTHOR_DISCLOSURE_INLINE_RESERVE = 4;

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
    let fitValidationFrame = 0;
    const scheduleFitValidation = (attempt = 0) => {
      window.cancelAnimationFrame(fitValidationFrame);
      fitValidationFrame = window.requestAnimationFrame(() => {
        if (!active || document.body.classList.contains("is-resizing-column")) return;
        const disclosure = container.querySelector<HTMLElement>(":scope > .author-toggle");
        if (!disclosure) return;
        const containerRect = container.getBoundingClientRect();
        const disclosureRect = disclosure.getBoundingClientRect();
        // Hidden measurement is intentionally fast, but font shaping and table
        // sub-pixels can still leave the real control a fraction wider. Never
        // solve that mismatch by clipping a word: yield one author and validate
        // the newly rendered line again until the complete label fits.
        if (disclosureRect.right > containerRect.right - AUTHOR_DISCLOSURE_INLINE_RESERVE) {
          setVisibleCount((current) => Math.max(1, current - 1));
          if (attempt < authors.length - 1) scheduleFitValidation(attempt + 1);
        }
      });
    };
    const commitVisibleCount = (nextVisibleCount: number) => {
      setVisibleCount(nextVisibleCount);
      scheduleFitValidation();
    };
    const measure = () => {
      if (!active || document.body.classList.contains("is-resizing-column")) return;
      // Fit against the actual visible author line. The table cell can extend
      // behind a neighboring fixed column, which previously let the algorithm
      // select a disclosure whose final word was then clipped by this element.
      const availableWidth = Math.max(0, container.clientWidth - AUTHOR_DISCLOSURE_INLINE_RESERVE);
      const nameWidths = Array.from(
        measurement.querySelectorAll<HTMLElement>("[data-author-measure-name]"),
        (node) => node.getBoundingClientRect().width,
      );
      const separatorWidth = measurement.querySelector<HTMLElement>("[data-author-measure-separator]")?.getBoundingClientRect().width ?? 0;
      const fullWidth = nameWidths.reduce((total, width) => total + width, 0)
        + separatorWidth * Math.max(0, nameWidths.length - 1);

      if (fullWidth <= availableWidth) {
        commitVisibleCount(nameWidths.length);
        return;
      }

      let nextVisibleCount = 0;
      let namesWidth = 0;
      for (let count = 1; count < nameWidths.length; count += 1) {
        namesWidth += nameWidths[count - 1] + (count > 1 ? separatorWidth : 0);
        const hiddenCount = nameWidths.length - count;
        const toggle = measurement.querySelector<HTMLElement>(`[data-author-toggle-count="${hiddenCount}"]`);
        const toggleStyle = toggle ? window.getComputedStyle(toggle) : null;
        const toggleWidth = toggle
          ? toggle.getBoundingClientRect().width
            + Number.parseFloat(toggleStyle?.marginInlineStart || "0")
            + Number.parseFloat(toggleStyle?.marginInlineEnd || "0")
          : 0;
        // Do not stop at the first miss: the disclosure label itself can become
        // narrower when its count drops from two digits to one.
        if (namesWidth + toggleWidth <= availableWidth) nextVisibleCount = count;
      }
      commitVisibleCount(Math.max(1, nextVisibleCount));
    };

    const animationFrame = window.requestAnimationFrame(measure);
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(container);
    // In table layouts the column can change before the author line reports its
    // own geometry. Observe the containing cell as well; measurement is frozen
    // during a drag and runs once from the final geometry on resize end.
    if (container.parentElement) resizeObserver.observe(container.parentElement);
    const cell = container.closest("td");
    if (cell) resizeObserver.observe(cell);
    window.addEventListener("stacks:resize-end", measure);
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
      window.cancelAnimationFrame(animationFrame);
      window.cancelAnimationFrame(fitValidationFrame);
      resizeObserver.disconnect();
      window.removeEventListener("stacks:resize-end", measure);
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
      <span data-author-measure-separator>, </span>
      {authors.slice(0, -1).map((_, index) => {
        const count = authors.length - index - 1;
        return <span key={count} className="author-toggle-measure" data-author-toggle-count={count}>{count} more {count === 1 ? "author" : "authors"}</span>;
      })}
    </span>
  );
}

export function AdaptiveAuthorNames({ authors, emptyLabel = "Authors not recorded" }: {
  authors: AuthorEntry[];
  emptyLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { containerRef, measurementRef, visibleCount } = useAdaptiveAuthorLine(authors);
  const visibleAuthors = expanded ? authors : authors.slice(0, visibleCount);
  const hiddenCount = Math.max(0, authors.length - visibleAuthors.length);

  if (!authors.length) {
    return <span className="expandable-author-list"><span>{emptyLabel}</span></span>;
  }

  return (
    <span ref={containerRef} className={`expandable-author-list is-adaptive-single-line ${expanded ? "is-expanded" : ""}`}>
      <span className="adaptive-author-name-run">
        {visibleAuthors.map((author, index) => (
          <span key={author.id}>
            {author.displayName}{index < visibleAuthors.length - 1 ? ",\u00a0" : ""}
            {expanded && index === visibleAuthors.length - 1 ? (
              <button
                type="button"
                className="author-toggle"
                aria-expanded="true"
                onClick={(event) => {
                  event.stopPropagation();
                  setExpanded(false);
                }}
              >
                Show fewer authors
              </button>
            ) : null}
          </span>
        ))}
      </span>
      {!expanded && hiddenCount ? (
        <button
          type="button"
          className="author-toggle"
          aria-expanded="false"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(true);
          }}
        >
          {`${hiddenCount} more ${hiddenCount === 1 ? "author" : "authors"}`}
        </button>
      ) : null}
      <AuthorMeasurement authors={authors} measurementRef={measurementRef} />
    </span>
  );
}

export function AdaptiveAuthorButtons({ authors, onOpenAuthor, showAll = false }: {
  authors: AuthorEntry[];
  onOpenAuthor: (authorName: string) => void;
  showAll?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { containerRef, measurementRef, visibleCount } = useAdaptiveAuthorLine(authors);
  const isExpanded = showAll || expanded;
  const visibleAuthors = isExpanded ? authors : authors.slice(0, visibleCount);
  const hiddenCount = Math.max(0, authors.length - visibleAuthors.length);

  if (!authors.length) {
    return <span className="expandable-author-buttons is-empty">No authors recorded</span>;
  }

  return (
    <span
      ref={containerRef}
      className={`expandable-author-buttons is-adaptive-single-line ${isExpanded ? "is-expanded" : ""} ${showAll ? "shows-all" : ""}`}
    >
      {visibleAuthors.map((author, index) => (
        <span key={author.id}>
          <button type="button" onClick={() => onOpenAuthor(author.displayName)}>{author.displayName}</button>
          {index < visibleAuthors.length - 1 ? ", " : ""}
          {!showAll && expanded && index === visibleAuthors.length - 1 ? (
            <button type="button" className="author-toggle" aria-expanded="true" onClick={() => setExpanded(false)}>
              Show fewer authors
            </button>
          ) : null}
        </span>
      ))}
      {!showAll && !expanded && hiddenCount ? (
        <button type="button" className="author-toggle" aria-expanded="false" onClick={() => setExpanded(true)}>
          {`${hiddenCount} more ${hiddenCount === 1 ? "author" : "authors"}`}
        </button>
      ) : null}
      {!showAll ? <AuthorMeasurement authors={authors} measurementRef={measurementRef} /> : null}
    </span>
  );
}
