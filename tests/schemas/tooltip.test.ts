/**
 * The rule deciding whether a `title` is worth showing.
 *
 * A tooltip repeating text already on screen is noise, so the app shows one only
 * when the text is truncated or when the tooltip says something the visible label
 * does not. Getting this wrong is not a crash, it is a page covered in bubbles
 * stating the obvious, which is exactly what the plain-`title` version did.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isTooltipRedundant } from "../../app/lib/tooltip-visibility.ts";

/**
 * A stand-in for the hovered element. `scrollWidth > clientWidth` is how the DOM
 * reports clipped text, so the shape here is the part of HTMLElement the rule reads.
 */
function element(options: {
  text: string;
  children?: Array<{ text: string; scroll?: number; client?: number; svg?: boolean }>;
  scroll?: number;
  client?: number;
}) {
  const self = {
    text: options.text,
    scrollWidth: options.scroll ?? 100,
    clientWidth: options.client ?? 100,
    scrollHeight: 20,
    clientHeight: 20,
    isHtml: true,
  };
  const children = (options.children ?? []).map((child) => ({
    text: child.text,
    scrollWidth: child.scroll ?? 100,
    clientWidth: child.client ?? 100,
    scrollHeight: 20,
    clientHeight: 20,
    isHtml: !child.svg,
  }));
  return { ...self, descendants: children };
}

test("a title repeating fully visible text is suppressed", () => {
  const row = element({ text: "Attention Is All You Need" });
  assert.equal(isTooltipRedundant(row, "Attention Is All You Need"), true);
});

test("the same title is shown once the text is clipped", () => {
  // The case `title` exists for: the ellipsised row needs the full string.
  const row = element({ text: "Attention Is All You Need", scroll: 420, client: 200 });
  assert.equal(isTooltipRedundant(row, "Attention Is All You Need"), false);
});

test("a title the visible text does not contain is always shown", () => {
  // "Show 3 more authors" against a button reading "3 more authors": the tooltip
  // carries the verb, so it is not a repeat.
  const row = element({ text: "3 more authors" });
  assert.equal(isTooltipRedundant(row, "Show 3 more authors"), false);
});

test("a row that shows the title above other text still counts as repeating it", () => {
  // A paper row renders the title over a meta line, so the row's text is LONGER
  // than the title while still containing it. Equality would have missed this and
  // shown a bubble on every row in the feed picker.
  const row = element({
    text: "Fantastic Adaptive Taxonomies Mert Cemri, Andrei Cojocaru +9 · arXiv · 2026",
    children: [
      { text: "Fantastic Adaptive Taxonomies" },
      { text: "Mert Cemri, Andrei Cojocaru +9 · arXiv · 2026" },
    ],
  });
  assert.equal(isTooltipRedundant(row, "Fantastic Adaptive Taxonomies"), true);
});

test("clipping is detected on the inner span that actually holds the title", () => {
  // The ellipsis lives on the title span, not the row, so measuring only the
  // hovered element would report "not clipped" and hide the one tooltip needed.
  const row = element({
    text: "A Very Long Paper Title Mert Cemri +9 · arXiv · 2026",
    children: [
      { text: "A Very Long Paper Title", scroll: 500, client: 240 },
      { text: "Mert Cemri +9 · arXiv · 2026" },
    ],
  });
  assert.equal(isTooltipRedundant(row, "A Very Long Paper Title"), false);
});

test("an icon does not make an unclipped row look truncated", () => {
  // The regression that put a bubble on every feed-picker row: an <svg> with a
  // 24-unit viewBox drawn at 14px reports scrollWidth 24 vs clientWidth 14, which
  // is indistinguishable from clipped text unless SVG is excluded.
  const row = element({
    text: "Gated Delta Networks",
    children: [
      { text: "", scroll: 24, client: 14, svg: true },
      { text: "Gated Delta Networks" },
    ],
  });
  assert.equal(isTooltipRedundant(row, "Gated Delta Networks"), true);
});

test("whitespace differences do not defeat the comparison", () => {
  // innerText wraps and indents; the attribute is one line.
  const row = element({ text: "Deep   Residual\n  Learning" });
  assert.equal(isTooltipRedundant(row, "Deep Residual Learning"), true);
});

test("an empty title is never treated as redundant text", () => {
  // Guard against `"".includes()` being trivially true, which would suppress by
  // accident rather than by rule.
  const row = element({ text: "anything at all" });
  assert.equal(isTooltipRedundant(row, ""), false);
  assert.equal(isTooltipRedundant(row, "   "), false);
});

test("a tooltip on an element with no visible text is shown", () => {
  // An icon-only control whose title genuinely adds information.
  const row = element({ text: "" });
  assert.equal(isTooltipRedundant(row, "Extract metadata from the stored PDF"), false);
});
