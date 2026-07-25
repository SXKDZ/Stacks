/**
 * Drag-to-reorder arithmetic for the author chips.
 *
 * Author position is stored data (`paper_authors.author_order` decides who reads
 * as first author), and the gap conversion is easy to get subtly wrong: the first
 * implementation double-applied the move, which made a one-step drag a no-op and
 * scrambled longer drags. Every case below is the kind of drag a user actually
 * performs.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { gapForPointer, moveItem, moveItemToGap } from "../../app/lib/reorder.ts";

const NAMES = ["A", "B", "C", "D", "E"];
const join = (items: string[]) => items.join("");

test("moveItem places an item at the requested index", () => {
  assert.equal(join(moveItem(NAMES, 0, 2)), "BCADE");
  assert.equal(join(moveItem(NAMES, 4, 0)), "EABCD");
  assert.equal(join(moveItem(NAMES, 2, 2)), "ABCDE", "a move to its own index is a no-op");
});

test("moveItem leaves the list alone for out-of-range indices", () => {
  assert.equal(join(moveItem(NAMES, -1, 2)), "ABCDE");
  assert.equal(join(moveItem(NAMES, 5, 0)), "ABCDE");
  // A destination past the end clamps to the end rather than dropping the item.
  assert.equal(join(moveItem(NAMES, 0, 99)), "BCDEA");
  assert.equal(join(moveItem(NAMES, 4, -3)), "EABCD");
  // The input is never mutated.
  const original = [...NAMES];
  moveItem(NAMES, 0, 3);
  assert.deepEqual(NAMES, original);
});

test("dragging one position earlier actually moves the name", () => {
  // The reported bug: dragging a chip one slot up did nothing at all, because
  // the drop was handled twice and the second pass undid the first.
  assert.equal(join(moveItemToGap(NAMES, 2, 1)), "ACBDE", "C dropped before B");
  assert.equal(join(moveItemToGap(NAMES, 1, 0)), "BACDE", "B dropped before A");
  assert.equal(join(moveItemToGap(NAMES, 4, 3)), "ABCED", "E dropped before D");
});

test("dragging one position later actually moves the name", () => {
  assert.equal(join(moveItemToGap(NAMES, 2, 4)), "ABDCE", "C dropped after D");
  assert.equal(join(moveItemToGap(NAMES, 0, 2)), "BACDE", "A dropped after B");
  assert.equal(join(moveItemToGap(NAMES, 3, 5)), "ABCED", "D dropped to the end");
});

test("dragging several positions lands exactly where the caret showed", () => {
  // The other half of the bug: a two-step drag scrambled the order entirely.
  assert.equal(join(moveItemToGap(NAMES, 2, 0)), "CABDE", "C to the very front");
  assert.equal(join(moveItemToGap(NAMES, 4, 0)), "EABCD", "last to first");
  assert.equal(join(moveItemToGap(NAMES, 0, 5)), "BCDEA", "first to last");
  assert.equal(join(moveItemToGap(NAMES, 0, 3)), "BCADE", "A into the middle");
  assert.equal(join(moveItemToGap(NAMES, 3, 1)), "ADBCE", "D two slots earlier");
});

test("dropping into either gap beside an item is a no-op", () => {
  // Both gaps adjacent to the dragged chip describe where it already is, so
  // neither may shuffle anything (this is what makes a small, imprecise drag
  // feel stable rather than jumpy).
  assert.equal(join(moveItemToGap(NAMES, 2, 2)), "ABCDE");
  assert.equal(join(moveItemToGap(NAMES, 2, 3)), "ABCDE");
  assert.equal(join(moveItemToGap(NAMES, 0, 0)), "ABCDE");
  assert.equal(join(moveItemToGap(NAMES, 0, 1)), "ABCDE");
  assert.equal(join(moveItemToGap(NAMES, 4, 4)), "ABCDE");
  assert.equal(join(moveItemToGap(NAMES, 4, 5)), "ABCDE");
});

test("every gap in a list is reachable and order-preserving", () => {
  // Exhaustive: for each source and each gap, the result must be a permutation
  // of the input with only the dragged item's position changed.
  for (let from = 0; from < NAMES.length; from += 1) {
    for (let gap = 0; gap <= NAMES.length; gap += 1) {
      const result = moveItemToGap(NAMES, from, gap);
      assert.equal(result.length, NAMES.length, `length preserved for ${from}->${gap}`);
      assert.deepEqual([...result].sort(), [...NAMES].sort(), `no name lost or duplicated for ${from}->${gap}`);
      // The others keep their relative order.
      const moved = NAMES[from];
      const othersBefore = NAMES.filter((name) => name !== moved);
      const othersAfter = result.filter((name) => name !== moved);
      assert.deepEqual(othersAfter, othersBefore, `relative order kept for ${from}->${gap}`);
    }
  }
});

test("a single-item and empty list survive any drag", () => {
  assert.deepEqual(moveItemToGap(["only"], 0, 0), ["only"]);
  assert.deepEqual(moveItemToGap(["only"], 0, 1), ["only"]);
  assert.deepEqual(moveItemToGap([], 0, 0), []);
});

test("gapForPointer picks the near side of the hovered chip", () => {
  const bounds = { left: 100, width: 60 }; // midpoint at 130
  assert.equal(gapForPointer(bounds, 101, 3), 3, "leading half inserts before");
  assert.equal(gapForPointer(bounds, 129, 3), 3);
  assert.equal(gapForPointer(bounds, 130, 3), 4, "exactly the midpoint inserts after");
  assert.equal(gapForPointer(bounds, 159, 3), 4, "trailing half inserts after");
  // Index 0's leading half is the very front of the list.
  assert.equal(gapForPointer(bounds, 105, 0), 0);
});
