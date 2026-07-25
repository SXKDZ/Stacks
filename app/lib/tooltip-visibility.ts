/**
 * Decides whether a `title` is worth showing as a tooltip.
 *
 * A tooltip that repeats text already on screen tells the reader nothing, so one is
 * shown only when the text is actually cut off or when the tooltip says something
 * the visible label does not. This lives apart from the component so the rule can be
 * tested against measurements directly, without a browser.
 */

/** The parts of an element the rule reads. Real DOM nodes satisfy this as-is. */
export interface MeasuredNode {
  /** `innerText` for an HTML element. */
  text: string;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  /**
   * False for SVG. An `<svg>` with a 24-unit viewBox drawn at 14px reports
   * scrollWidth 24 against clientWidth 14, which is indistinguishable from clipped
   * text, so icons must not be measured.
   */
  isHtml: boolean;
}

export interface MeasuredElement extends MeasuredNode {
  descendants: MeasuredNode[];
}

/** Collapse whitespace so wrapped, indented `innerText` compares to a one-line title. */
export function normalizeTooltipText(text: string | null | undefined) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * True when the element rendering `title` has it visually cut off, in either axis.
 *
 * Only the nodes that actually carry the text are measured: the ellipsis is usually
 * on an inner span rather than the hovered row, and every other descendant (icons
 * especially) reports overflow for reasons unrelated to the text.
 */
function isClipped(element: MeasuredElement, title: string) {
  return [element, ...element.descendants]
    .filter((node) => node.isHtml && normalizeTooltipText(node.text).includes(title))
    .some((node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1);
}

/**
 * True when the tooltip would only repeat what the reader can already see.
 *
 * Containment rather than equality: a paper row renders its title above a meta
 * line, so the row's text is longer than the title while still fully containing it.
 */
export function isTooltipRedundant(element: MeasuredElement, title: string) {
  const wanted = normalizeTooltipText(title);
  if (!wanted) return false;
  return normalizeTooltipText(element.text).includes(wanted) && !isClipped(element, wanted);
}

/** Read a live DOM element into the shape the rule measures. */
export function measureElement(element: HTMLElement): MeasuredElement {
  const read = (node: Element): MeasuredNode => ({
    text: node instanceof HTMLElement ? node.innerText : "",
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    isHtml: node instanceof HTMLElement,
  });
  return { ...read(element), descendants: [...element.querySelectorAll("*")].map(read) };
}
