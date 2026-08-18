"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Check, ChevronDown, ChevronUp, Copy, Hand, Minus, MousePointer2, Plus, RotateCcw, Scan, Search } from "lucide-react";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { Select } from "@/app/components/ui/controls";
import { cycleTableSort, useResizableColumns, type TableSort } from "@/app/components/ui/ResizableTable";
import { contentFingerprint, readFeedVisualization, type FeedVisualization } from "@/app/lib/feed-visualization";

type PageState =
  | { status: "loading" }
  | { status: "ready"; visualization: FeedVisualization; mermaidSvg?: string }
  | { status: "error"; message: string };

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const MIN_ROW_HEIGHT = 36;
const MAX_ROW_HEIGHT = 480;
const DEFAULT_ROW_HEIGHT = 44;
const CODE_LANGUAGE_OPTIONS = [
  "plaintext", "bash", "css", "html", "javascript", "typescript", "jsx", "tsx", "json", "markdown",
  "python", "ruby", "php", "java", "csharp", "cpp", "go", "rust", "swift", "kotlin", "sql", "yaml", "latex",
];

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function elementInsets(element: Element | null): { horizontal: number; vertical: number } {
  if (!element) return { horizontal: 0, vertical: 0 };
  const style = window.getComputedStyle(element);
  const pixels = (property: string) => Number.parseFloat(style.getPropertyValue(property)) || 0;
  return {
    horizontal: pixels("padding-left") + pixels("padding-right") + pixels("border-left-width") + pixels("border-right-width"),
    vertical: pixels("padding-top") + pixels("padding-bottom") + pixels("border-top-width") + pixels("border-bottom-width"),
  };
}

function visualizationKindLabel(visualization: FeedVisualization): string {
  if (visualization.kind === "mermaid") return "Mermaid visualization";
  if (visualization.kind === "image") return "Image";
  if (visualization.kind === "code") return "Code snippet";
  return "Table";
}

function visualizationTitle(visualization: FeedVisualization): string {
  return `${visualizationKindLabel(visualization)} · ${visualization.feedName}`;
}

function ViewerShell({ title, controls, children }: { title: string; controls?: ReactNode; children: ReactNode }) {
  return (
    <main className="mermaid-visualization-page workspace-enter app-interaction-scope">
      <header className="mermaid-visualization-header">
        <h1>{title}</h1>
        {controls}
      </header>
      {children}
    </main>
  );
}

function ZoomableViewer({ visualization, mermaidSvg }: {
  visualization: Extract<FeedVisualization, { kind: "mermaid" | "image" }>;
  mermaidSvg?: string;
}) {
  const viewportRef = useRef<HTMLElement | null>(null);
  const visualRef = useRef<HTMLDivElement | null>(null);
  const fittedScaleRef = useRef(1);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number; moved: boolean } | null>(null);
  const lastPanTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [interactionMode, setInteractionMode] = useState<"pan" | "select">("pan");

  const fitSize = useCallback((size: { width: number; height: number }) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const viewportInsets = elementInsets(viewport);
    const canvasInsets = elementInsets(visualRef.current?.parentElement ?? null);
    const availableWidth = Math.max(1, viewport.clientWidth - viewportInsets.horizontal - canvasInsets.horizontal);
    const availableHeight = Math.max(1, viewport.clientHeight - viewportInsets.vertical - canvasInsets.vertical);
    const fittedScale = clampScale(Math.min(1, availableWidth / size.width, availableHeight / size.height));
    fittedScaleRef.current = fittedScale;
    setScale(fittedScale);
  }, []);

  useLayoutEffect(() => {
    if (visualization.kind !== "mermaid" || !mermaidSvg) return;
    const svg = visualRef.current?.querySelector("svg");
    if (!svg) return;
    const viewBox = svg.viewBox?.baseVal;
    const bounds = svg.getBoundingClientRect();
    const size = { width: viewBox?.width || bounds.width || 1, height: viewBox?.height || bounds.height || 1 };
    setBaseSize(size);
    fitSize(size);
  }, [fitSize, mermaidSvg, visualization.kind]);

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || interactionMode !== "pan" || event.button !== 0) return;
    viewport.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, moved: false };
    setDragging(true);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const viewport = viewportRef.current;
    const drag = dragRef.current;
    if (!viewport || !drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (Math.hypot(deltaX, deltaY) > 4) drag.moved = true;
    viewport.scrollLeft = drag.scrollLeft - deltaX;
    viewport.scrollTop = drag.scrollTop - deltaY;
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const viewport = viewportRef.current;
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (viewport?.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
    if (!drag.moved && interactionMode === "pan") {
      const previous = lastPanTapRef.current;
      const now = event.timeStamp;
      if (previous && now - previous.time <= 400 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 16) {
        lastPanTapRef.current = null;
        advanceDoubleClickZoom({ clientX: event.clientX, clientY: event.clientY });
      } else {
        lastPanTapRef.current = { time: now, x: event.clientX, y: event.clientY };
      }
    }
  };

  const fit = useCallback(() => {
    if (baseSize) fitSize(baseSize);
  }, [baseSize, fitSize]);

  const zoomBy = useCallback((factor: number, anchor?: { clientX: number; clientY: number }) => {
    const viewport = viewportRef.current;
    setScale((current) => {
      const next = clampScale(current * factor);
      if (!viewport || !anchor || next === current) return next;
      const bounds = viewport.getBoundingClientRect();
      const offsetX = anchor.clientX - bounds.left;
      const offsetY = anchor.clientY - bounds.top;
      const contentX = viewport.scrollLeft + offsetX;
      const contentY = viewport.scrollTop + offsetY;
      const ratio = next / current;
      requestAnimationFrame(() => {
        viewport.scrollLeft = contentX * ratio - offsetX;
        viewport.scrollTop = contentY * ratio - offsetY;
      });
      return next;
    });
  }, []);

  const advanceDoubleClickZoom = useCallback((anchor: { clientX: number; clientY: number }) => {
    if (Math.abs(scale - 1) < 0.01) {
      if (Math.abs(fittedScaleRef.current - 1) < 0.01) zoomBy(1.2, anchor);
      else fit();
    } else {
      setScale(1);
    }
  }, [fit, scale, zoomBy]);

  const handleWheel = (event: ReactWheelEvent<HTMLElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomBy(Math.exp(-event.deltaY * 0.002), { clientX: event.clientX, clientY: event.clientY });
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "+" || event.key === "=") zoomBy(1.2);
      if (event.key === "-") zoomBy(1 / 1.2);
      if (event.key === "0") setScale(1);
      if (event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        fit();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [fit, zoomBy]);

  const controls = (
    <div className="mermaid-visualization-controls">
      {visualization.kind === "mermaid" ? (
        <div className="mermaid-mode-controls" aria-label="Diagram interaction mode">
          <button type="button" aria-pressed={interactionMode === "pan"} onClick={() => setInteractionMode("pan")}><Hand /> Pan</button>
          <button type="button" aria-pressed={interactionMode === "select"} onClick={() => setInteractionMode("select")}><MousePointer2 /> Select</button>
        </div>
      ) : null}
      <div className="mermaid-zoom-controls" aria-label="Zoom controls">
        <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out" aria-keyshortcuts="-"><Minus /></button>
        <output aria-live="polite">{Math.round(scale * 100)}%</output>
        <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in" aria-keyshortcuts="+"><Plus /></button>
        <button type="button" onClick={fit} aria-keyshortcuts="F"><Scan /> Fit</button>
        <button type="button" onClick={() => setScale(1)} aria-keyshortcuts="0"><RotateCcw /> Reset</button>
      </div>
    </div>
  );

  return (
    <ViewerShell title={visualizationTitle(visualization)} controls={controls}>
      <section
        ref={viewportRef}
        className={`mermaid-visualization-viewport ${interactionMode === "select" ? "is-selection-mode" : ""} ${dragging ? "is-dragging" : ""}`.trim()}
        aria-label="Visualization viewport"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={handleWheel}
      >
        <div className="mermaid-visualization-canvas">
          {visualization.kind === "mermaid" && mermaidSvg ? (
            <div
              ref={visualRef}
              className="mermaid-visualization-svg"
              role="img"
              aria-label="Mermaid diagram"
              style={baseSize ? { width: baseSize.width * scale, height: baseSize.height * scale } : undefined}
              dangerouslySetInnerHTML={{ __html: mermaidSvg }}
            />
          ) : null}
          {visualization.kind === "image" ? (
            <div
              ref={visualRef}
              className="feed-image-visualization"
              style={baseSize ? { width: baseSize.width * scale, height: baseSize.height * scale } : undefined}
            >
              <img
                src={visualization.src}
                alt={visualization.alt}
                onLoad={(event) => {
                  const size = { width: event.currentTarget.naturalWidth || 1, height: event.currentTarget.naturalHeight || 1 };
                  setBaseSize(size);
                  fitSize(size);
                }}
              />
            </div>
          ) : null}
        </div>
      </section>
    </ViewerShell>
  );
}

function fenceCode(source: string, language: string): string {
  const longest = (source.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${source}\n${fence}`;
}

function CodeViewer({ visualization }: { visualization: Extract<FeedVisualization, { kind: "code" }> }) {
  const [copied, setCopied] = useState(false);
  const [language, setLanguage] = useState(visualization.language);
  const [showLineNumbers, setShowLineNumbers] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const languageOptions = useMemo(() => Array.from(new Set([language, ...CODE_LANGUAGE_OPTIONS].filter(Boolean))).map((value) => ({
    value,
    label: value,
  })), [language]);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);
  const copy = async () => {
    await navigator.clipboard.writeText(visualization.source);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1600);
  };
  const controls = (
    <div className="feed-code-controls">
      <div className="feed-code-language">
        <span>Language</span>
        <Select
          value={language}
          options={languageOptions}
          onChange={setLanguage}
          ariaLabel="Syntax highlighting language"
          placeholder="plaintext"
          className="feed-code-language-select"
        />
      </div>
      <label className="feed-code-option">
        <input
          type="checkbox"
          checked={showLineNumbers}
          onChange={(event) => setShowLineNumbers(event.target.checked)}
        />
        <span>Line numbers</span>
      </label>
      <label className="feed-code-option">
        <input
          type="checkbox"
          checked={wrapLines}
          onChange={(event) => setWrapLines(event.target.checked)}
        />
        <span>Wrap lines</span>
      </label>
      <div className="mermaid-zoom-controls">
        <button type="button" onClick={() => void copy()}>{copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy code"}</button>
      </div>
    </div>
  );
  return (
    <ViewerShell title={visualizationTitle(visualization)} controls={controls}>
      <section className="feed-code-visualization" aria-label="Code snippet">
        <MarkdownContent
          content={fenceCode(visualization.source, language)}
          className={`${showLineNumbers ? "code-show-line-numbers" : ""} ${wrapLines ? "code-wrap-lines" : ""}`}
          showCodeLineNumbers={showLineNumbers}
          wrapCodeLines={wrapLines}
        />
      </section>
    </ViewerShell>
  );
}

function VisualizationTableHeader({ label, columnKey, sort, onSort, onResize, onResetWidth, rowResizeHandle, columnHighlighted, onHighlightColumn }: {
  label: string;
  columnKey: string;
  sort: TableSort<string>;
  onSort: (key: string) => void;
  onResize: (event: ReactPointerEvent<HTMLElement>, key: string) => void;
  onResetWidth: (event: ReactMouseEvent<HTMLElement>, key: string) => void;
  rowResizeHandle: ReactNode;
  columnHighlighted: boolean;
  onHighlightColumn: (highlighted: boolean) => void;
}) {
  const active = sort.key === columnKey;
  return (
    <th
      className={columnHighlighted ? "is-column-resize-highlight" : undefined}
      aria-sort={active ? sort.direction === "asc" ? "ascending" : "descending" : "none"}
    >
      <button type="button" className={`feed-table-sort ${active ? "is-active" : ""}`} onClick={() => onSort(columnKey)}>
        <span>{label}</span>
        {active ? sort.direction === "asc" ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" /> : null}
      </button>
      <button
        type="button"
        className="feed-table-column-resize"
        aria-label={`Resize ${label} column`}
        onPointerDown={(event) => onResize(event, columnKey)}
        onDoubleClick={(event) => onResetWidth(event, columnKey)}
        onPointerEnter={() => onHighlightColumn(true)}
        onPointerLeave={() => onHighlightColumn(false)}
        onFocus={() => onHighlightColumn(true)}
        onBlur={() => onHighlightColumn(false)}
      />
      {rowResizeHandle}
    </th>
  );
}

function RowResizeHandle({ interactive, label, onPointerDown, onPointerMove, onPointerUp, onKeyDown, onHighlight }: {
  interactive: boolean;
  label: string;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onHighlight: (highlighted: boolean) => void;
}) {
  if (interactive) {
    return (
      <button
        type="button"
        className="feed-table-row-resize"
        aria-label={`${label}. Use up and down arrow keys.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={() => onHighlight(true)}
        onPointerLeave={() => onHighlight(false)}
        onFocus={() => onHighlight(true)}
        onBlur={() => onHighlight(false)}
        onKeyDown={onKeyDown}
      />
    );
  }
  return (
    <span
      className="feed-table-row-resize"
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerEnter={() => onHighlight(true)}
      onPointerLeave={() => onHighlight(false)}
    />
  );
}

function TableViewer({ visualization }: { visualization: Extract<FeedVisualization, { kind: "table" }> }) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<TableSort<string>>({ key: "", direction: "asc" });
  const headers = useMemo(() => {
    const columnCount = Math.max(visualization.headers.length, ...visualization.rows.map((row) => row.length), 1);
    return Array.from({ length: columnCount }, (_, index) => visualization.headers[index] || `Column ${index + 1}`);
  }, [visualization.headers, visualization.rows]);
  const columnKeys = useMemo(() => headers.map((_, index) => `column-${index}`), [headers]);
  const defaultColumnWidths = useMemo(() => Object.fromEntries(columnKeys.map((key) => [key, 1])) as Record<string, number>, [columnKeys]);
  const minimumColumnWidths = useMemo(() => Object.fromEntries(columnKeys.map((key) => [key, 96])) as Record<string, number>, [columnKeys]);
  const columnStorageKey = useMemo(() => `stacks-feed-table-widths-v1:${contentFingerprint(JSON.stringify(headers))}`, [headers]);
  const { widths: columnWidths, resizeColumn, resetColumnWidth } = useResizableColumns(
    columnStorageKey,
    defaultColumnWidths,
    minimumColumnWidths,
    columnKeys,
  );
  const columnWidthTotal = columnKeys.reduce((total, key) => total + columnWidths[key], 0) || 1;
  const [highlightedColumn, setHighlightedColumn] = useState<number | null>(null);
  const [highlightedRow, setHighlightedRow] = useState<"header" | number | null>(null);
  const [headerHeight, setHeaderHeight] = useState(DEFAULT_ROW_HEIGHT);
  const [rowHeights, setRowHeights] = useState(() => visualization.rows.map(() => DEFAULT_ROW_HEIGHT));
  const rowResizeRef = useRef<{ pointerId: number; target: "header" | number; start: number; size: number } | null>(null);
  const rows = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    const indexedRows = visualization.rows.map((cells, originalIndex) => ({ cells, originalIndex }));
    const filtered = query ? indexedRows.filter(({ cells }) => cells.some((cell) => cell.toLocaleLowerCase().includes(query))) : indexedRows;
    const sortColumn = columnKeys.indexOf(sort.key);
    if (sortColumn < 0) return filtered;
    return filtered.sort((left, right) => {
      const order = (left.cells[sortColumn] ?? "").localeCompare(right.cells[sortColumn] ?? "", undefined, { numeric: true, sensitivity: "base" });
      return sort.direction === "asc" ? order : -order;
    });
  }, [columnKeys, filter, sort, visualization.rows]);

  const toggleSort = (columnKey: string) => {
    setSort((current) => cycleTableSort(current, columnKey, { key: "", direction: "asc" }, () => false));
  };

  const beginColumnResize = (event: ReactPointerEvent<HTMLElement>, columnKey: string, columnIndex: number) => {
    setHighlightedColumn(columnIndex);
    resizeColumn(event, columnKey);
    const clear = () => {
      setHighlightedColumn(null);
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("pointercancel", clear);
    };
    window.addEventListener("pointerup", clear, { once: true });
    window.addEventListener("pointercancel", clear, { once: true });
  };

  const hoverColumn = (columnIndex: number, highlighted: boolean) => {
    if (highlighted) setHighlightedColumn(columnIndex);
    else if (!document.body.classList.contains("is-resizing-column")) setHighlightedColumn(null);
  };

  const updateRowHeight = (target: "header" | number, height: number) => {
    const next = Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, height));
    if (target === "header") {
      setHeaderHeight(next);
    } else {
      setRowHeights((current) => current.map((value, index) => index === target ? next : value));
    }
  };

  const beginRowResize = (event: ReactPointerEvent<HTMLElement>, target: "header" | number) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setHighlightedRow(target);
    rowResizeRef.current = {
      pointerId: event.pointerId,
      target,
      start: event.clientY,
      size: event.currentTarget.closest("tr")?.getBoundingClientRect().height
        ?? (target === "header" ? headerHeight : rowHeights[target]),
    };
  };

  const moveRowResize = (event: ReactPointerEvent<HTMLElement>) => {
    const resize = rowResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    updateRowHeight(resize.target, resize.size + event.clientY - resize.start);
  };

  const endRowResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (rowResizeRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    rowResizeRef.current = null;
    setHighlightedRow(null);
  };

  const hoverRow = (target: "header" | number, highlighted: boolean) => {
    if (highlighted) setHighlightedRow(target);
    else if (!rowResizeRef.current) setHighlightedRow(null);
  };

  const resizeRowWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>, target: "header" | number) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const change = (event.shiftKey ? 24 : 8) * (event.key === "ArrowDown" ? 1 : -1);
    const renderedHeight = event.currentTarget.closest("tr")?.getBoundingClientRect().height
      ?? (target === "header" ? headerHeight : rowHeights[target]);
    updateRowHeight(target, renderedHeight + change);
  };

  const controls = (
    <label className="feed-table-filter">
      <Search aria-hidden="true" />
      <span className="sr-only">Filter table rows</span>
      <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter rows…" />
    </label>
  );

  return (
    <ViewerShell title={visualizationTitle(visualization)} controls={controls}>
      <section className="feed-table-visualization" aria-label="Interactive table">
        <p className="feed-table-result-count" role="status">{rows.length} of {visualization.rows.length} rows</p>
        <div className="feed-table-visualization-scroll">
          <table className="feed-visualization-table">
            <colgroup>{columnKeys.map((key) => <col key={key} style={{ width: `${(columnWidths[key] / columnWidthTotal) * 100}%` }} />)}</colgroup>
            <thead><tr
              className={highlightedRow === "header" ? "is-row-resize-highlight" : undefined}
              style={{ "--feed-table-row-height": `${headerHeight}px` } as CSSProperties}
            >{headers.map((header, index) => (
                <VisualizationTableHeader
                key={`${header}-${index}`}
                label={header}
                columnKey={columnKeys[index]}
                sort={sort}
                onSort={toggleSort}
                onResize={(event, columnKey) => beginColumnResize(event, columnKey, index)}
                onResetWidth={resetColumnWidth}
                columnHighlighted={highlightedColumn === index}
                onHighlightColumn={(highlighted) => hoverColumn(index, highlighted)}
                rowResizeHandle={(
                  <RowResizeHandle
                    interactive={index === 0}
                    label="Resize header row"
                    onPointerDown={(event) => beginRowResize(event, "header")}
                    onPointerMove={moveRowResize}
                    onPointerUp={endRowResize}
                    onKeyDown={(event) => resizeRowWithKeyboard(event, "header")}
                    onHighlight={(highlighted) => hoverRow("header", highlighted)}
                  />
                )}
              />
            ))}</tr></thead>
            <tbody>{rows.map(({ cells, originalIndex }, rowIndex) => (
              <tr
                className={`feed-table-row ${highlightedRow === originalIndex ? "is-row-resize-highlight" : ""}`.trim()}
                key={`${cells.join("\u0000")}-${originalIndex}`}
                style={{ "--feed-table-row-height": `${rowHeights[originalIndex]}px` } as CSSProperties}
              >
                {headers.map((_, cellIndex) => (
                  <td
                    key={cellIndex}
                    className={highlightedColumn === cellIndex ? "is-column-resize-highlight" : undefined}
                  >
                    <div className="feed-table-cell-content">{cells[cellIndex] ?? ""}</div>
                    <span
                      className="feed-table-column-resize feed-table-column-resize-body"
                      aria-hidden="true"
                      onPointerDown={(event) => beginColumnResize(event, columnKeys[cellIndex], cellIndex)}
                      onDoubleClick={(event) => resetColumnWidth(event, columnKeys[cellIndex])}
                      onPointerEnter={() => hoverColumn(cellIndex, true)}
                      onPointerLeave={() => hoverColumn(cellIndex, false)}
                    />
                    <RowResizeHandle
                      interactive={cellIndex === 0}
                      label={`Resize row ${rowIndex + 1}`}
                      onPointerDown={(event) => beginRowResize(event, originalIndex)}
                      onPointerMove={moveRowResize}
                      onPointerUp={endRowResize}
                      onKeyDown={(event) => resizeRowWithKeyboard(event, originalIndex)}
                      onHighlight={(highlighted) => hoverRow(originalIndex, highlighted)}
                    />
                  </td>
                ))}
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
    </ViewerShell>
  );
}

export default function FeedVisualizationPage() {
  const [state, setState] = useState<PageState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const id = new URLSearchParams(window.location.search).get("id");
    const visualization = id ? readFeedVisualization(id) : null;

    void (async () => {
      try {
        if (!visualization) throw new Error("This visualization is no longer available. Open it again from the AI feed.");
        document.documentElement.dataset.theme = visualization.theme;
        document.documentElement.style.colorScheme = visualization.theme;
        if (visualization.kind !== "mermaid") {
          if (!cancelled) setState({ status: "ready", visualization });
          return;
        }
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: visualization.theme === "dark" ? "dark" : "default",
          fontFamily: "var(--font-ui)",
        });
        const { svg } = await mermaid.render(`standalone-mermaid-${crypto.randomUUID()}`, visualization.source);
        if (!cancelled) setState({ status: "ready", visualization, mermaidSvg: svg });
      } catch (error) {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : "The visualization could not be loaded." });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state.status !== "ready") return;
    const title = `${visualizationTitle(state.visualization)} · Stacks`;
    const applyTitle = () => {
      if (document.title !== title) document.title = title;
    };
    applyTitle();
    const observer = new MutationObserver(applyTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [state]);

  if (state.status === "loading") {
    return <ViewerShell title="Visualization"><section className="feed-visualization-message"><p role="status">Loading…</p></section></ViewerShell>;
  }
  if (state.status === "error") {
    return <ViewerShell title="Visualization"><section className="feed-visualization-message"><p role="alert">{state.message}</p></section></ViewerShell>;
  }
  if (state.visualization.kind === "mermaid" || state.visualization.kind === "image") {
    return <ZoomableViewer visualization={state.visualization} mermaidSvg={state.mermaidSvg} />;
  }
  if (state.visualization.kind === "code") return <CodeViewer visualization={state.visualization} />;
  return <TableViewer visualization={state.visualization} />;
}
