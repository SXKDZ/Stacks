"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState, type AriaAttributes, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { beginPointerResize } from "@/app/lib/pointer-resize";

export interface TableSort<Key extends string> {
  key: Key;
  direction: "asc" | "desc";
}

export function cycleTableSort<Key extends string>(
  current: TableSort<Key>,
  key: Key,
  fallback: TableSort<Key>,
  descendingFirst: (key: Key) => boolean,
): TableSort<Key> {
  const firstDirection: "asc" | "desc" = descendingFirst(key) ? "desc" : "asc";
  if (current.key !== key) return { key, direction: firstDirection };
  if (current.direction === firstDirection) {
    return { key, direction: firstDirection === "asc" ? "desc" : "asc" };
  }
  return fallback;
}

/**
 * The proportional, pane-fitting column resize behavior shared by the library
 * grids and standalone feed table viewer.
 */
export function useResizableColumns<Key extends string>(
  storageKey: string,
  defaults: Record<Key, number>,
  minimums: Record<Key, number>,
  resizableKeys: Key[] = Object.keys(defaults) as Key[],
) {
  const [widths, setWidths] = useState<Record<Key, number>>(defaults);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Partial<Record<Key, number>> | null;
        if (saved && Object.values(saved).every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) {
          setWidths((current) => ({ ...current, ...saved }));
        }
      } catch {
        // Invalid browser preferences fall back to the balanced default widths.
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [storageKey]);

  function resizeColumn(event: ReactPointerEvent<HTMLElement>, key: Key) {
    event.preventDefault();
    event.stopPropagation();
    const header = event.currentTarget.closest("th, td");
    const table = event.currentTarget.closest("table");
    if (!header || !table) return;
    const startX = event.clientX;
    const startWidth = header.getBoundingClientRect().width;
    const resizableWidth = [...table.querySelectorAll("th.is-resizable")]
      .reduce((total, cell) => total + cell.getBoundingClientRect().width, 0)
      || table.getBoundingClientRect().width;
    const others = resizableKeys.filter((candidate) => candidate !== key);
    const neighbourFloor = others.reduce((total, candidate) => total + minimums[candidate], 0);
    const ceiling = Math.max(minimums[key], resizableWidth - neighbourFloor);

    beginPointerResize(event.pointerId, (clientX) => {
      const targetWidth = Math.min(ceiling, Math.max(minimums[key], startWidth + clientX - startX));
      setWidths((current) => {
        const pool = resizableKeys.reduce((total, candidate) => total + current[candidate], 0);
        if (pool <= 0) return current;
        const floorFor = (candidate: Key) => (minimums[candidate] / resizableWidth) * pool;
        const othersFloor = others.reduce((total, candidate) => total + floorFor(candidate), 0);
        const share = Math.min(
          Math.max(floorFor(key), (targetWidth / resizableWidth) * pool),
          Math.max(floorFor(key), pool - othersFloor),
        );
        const next = { ...current, [key]: Number(share.toFixed(3)) } as Record<Key, number>;
        const surplus = Math.max(0, pool - share - othersFloor);
        const slackTotal = others.reduce((total, candidate) => total + Math.max(0, current[candidate] - floorFor(candidate)), 0);
        for (const candidate of others) {
          const slack = Math.max(0, current[candidate] - floorFor(candidate));
          const extra = slackTotal > 0 ? (slack / slackTotal) * surplus : surplus / (others.length || 1);
          next[candidate] = Number((floorFor(candidate) + extra).toFixed(3));
        }
        window.localStorage.setItem(storageKey, JSON.stringify(next));
        return next;
      });
    });
  }

  function resetColumnWidth(event: ReactMouseEvent<HTMLElement>, key: Key) {
    event.preventDefault();
    event.stopPropagation();
    setWidths((current) => {
      const next = { ...current, [key]: defaults[key] };
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  }

  return { widths, resizeColumn, resetColumnWidth };
}

export function SortableTableHeader<Key extends string>({
  label,
  columnKey,
  sort,
  onSort,
  onResize,
  onResetWidth,
  centered = false,
  resizable = true,
}: {
  label: string;
  columnKey: Key;
  sort: { key: string; direction: "asc" | "desc" };
  onSort: (key: Key) => void;
  onResize: (event: ReactPointerEvent<HTMLElement>, key: Key) => void;
  onResetWidth: (event: ReactMouseEvent<HTMLElement>, key: Key) => void;
  centered?: boolean;
  resizable?: boolean;
}) {
  const active = sort.key === columnKey;
  const ariaSort: AriaAttributes["aria-sort"] = active
    ? sort.direction === "asc" ? "ascending" : "descending"
    : "none";
  return (
    <th aria-sort={ariaSort} className={`${resizable ? "is-resizable" : "is-fixed-width"} ${centered ? "is-centered" : ""}`.trim()}>
      <button type="button" className={`table-sort-button ${active ? "is-active" : ""}`} onClick={() => onSort(columnKey)}>
        <span>{label}</span>
        {active ? sort.direction === "asc" ? <ChevronUp size={14} /> : <ChevronDown size={14} /> : null}
      </button>
      {resizable ? (
        <button
          type="button"
          className="column-resize-handle"
          aria-label={`Resize ${label} column`}
          title={`Drag to resize ${label}; double-click to reset`}
          onPointerDown={(event) => onResize(event, columnKey)}
          onDoubleClick={(event) => onResetWidth(event, columnKey)}
        />
      ) : null}
    </th>
  );
}
