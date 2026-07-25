/**
 * Ordering helpers for drag-to-reorder lists (currently the author-name chips,
 * where position is stored data: `paper_authors.author_order` decides who reads
 * as first author).
 *
 * The arithmetic lives here rather than inside the component so it can be tested
 * directly. Getting it wrong is easy and the symptom is subtle: an off-by-one in
 * the gap conversion silently makes a one-step drag a no-op, and a longer drag
 * land in the wrong place.
 */

/**
 * Move the item at `from` so it sits at index `to` in the resulting list.
 * Out-of-range and no-op moves return the original list unchanged.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  return next;
}

/**
 * Move the item at `from` into a *gap*, where gap `g` means "between item g-1
 * and item g" (so 0 is before everything and `items.length` is after
 * everything).
 *
 * Removing the dragged item first shifts every later gap down by one, which is
 * the conversion this function owns: a gap past the item's own position maps to
 * `gap - 1`. Dropping into either gap adjacent to the item is a no-op, since
 * both describe the position it already occupies.
 */
export function moveItemToGap<T>(items: readonly T[], from: number, gap: number): T[] {
  if (from < 0 || from >= items.length) {
    return [...items];
  }
  if (gap === from || gap === from + 1) {
    return [...items];
  }
  return moveItem(items, from, gap > from ? gap - 1 : gap);
}

/**
 * The insertion gap nearest a pointer over the item at `index`: the gap before
 * it when the pointer is on its leading half, the gap after it otherwise.
 */
export function gapForPointer(bounds: { left: number; width: number }, clientX: number, index: number): number {
  return clientX < bounds.left + bounds.width / 2 ? index : index + 1;
}
