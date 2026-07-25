"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { isTooltipRedundant, measureElement } from "../../lib/tooltip-visibility";

/**
 * Renders `title` tooltips in the app's own style instead of the browser's.
 *
 * A native tooltip can't be styled, appears after a browser-controlled delay in a
 * browser-controlled position, and looks like the operating system rather than
 * Stacks. This listens once at the document level and draws the tooltip itself,
 * so every existing `title="..."` gets the app's styling with no call-site
 * changes, and assistive technology still reads the attribute.
 *
 * The trick for suppressing the native bubble: move the text to `data-title`
 * while the element is hovered or focused, then restore it on the way out. The
 * attribute is only absent during the hover, so a screen reader outside that
 * window still sees it, and nothing is lost if this component never mounts.
 */

/** How long the pointer must rest before the tooltip appears. */
const HOVER_DELAY_MS = 350;
/**
 * Gap below the cursor. Large enough to clear the pointer graphic itself (a
 * typical arrow is ~20px tall), so the bubble sits under the cursor rather than
 * beneath its tip where the pointer overlaps the first line of text.
 */
const OFFSET = 20;

interface TooltipState {
  text: string;
  /** Where to put it, in viewport coordinates: just below the pointer. */
  x: number;
  y: number;
  /** The anchor's bottom, used to flip above it when there is no room below. */
  anchorTop: number;
}

/**
 * The bubble itself.
 *
 * Measured off-screen on the first pass, then placed on the second. Measuring in
 * position doesn't work: the browser sizes a fixed element to the room left
 * between its `left` and the viewport edge, so a bubble near the right edge was
 * squeezed to ~127px and the same title wrapped over six lines there but two lines
 * elsewhere. Rendering at the top-left first yields the true natural width, and the
 * edge clamp then uses that.
 */
function TooltipBubble({ text, x, y, anchorTop }: { text: string; x: number; y: number; anchorTop: number }) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  // A layout effect, not a ref callback: the callback does not re-run when only
  // `text` changes (same element), which left the bubble stuck in its hidden
  // measuring state. Reset-then-measure keyed on the text handles both.
  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setBox({ width: rect.width, height: rect.height });
  }, [text]);

  const margin = 8;
  const measured = box !== null;
  // Below the pointer by default; above the ANCHOR when there is no room below, so
  // the bubble never covers the thing it describes.
  const fitsBelow = measured && y + OFFSET + box.height + margin <= window.innerHeight;
  const top = !measured ? 0 : fitsBelow ? y + OFFSET : Math.max(margin, anchorTop - OFFSET - box.height);
  // Centred on the pointer, then pulled back inside either edge using the real width.
  const left = !measured
    ? 0
    : Math.min(
      Math.max(margin, x - box.width / 2),
      Math.max(margin, window.innerWidth - box.width - margin),
    );

  return (
    <div
      ref={nodeRef}
      className="app-tooltip"
      role="tooltip"
      aria-hidden="true"
      style={{
        top,
        left,
        // Hidden for the measuring pass only, so the first paint is never at the
        // wrong spot; pinned to the measured width once placed.
        visibility: measured ? "visible" : "hidden",
        ...(measured ? { width: box.width } : {}),
      }}
    >
      {text}
    </div>
  );
}

export function TooltipLayer() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    // The element whose `title` we moved aside, so it can always be restored.
    let stripped: HTMLElement | null = null;

    const restore = () => {
      if (stripped) {
        const text = stripped.dataset.tooltip;
        if (text !== undefined) {
          stripped.setAttribute("title", text);
          delete stripped.dataset.tooltip;
        }
        stripped = null;
      }
    };

    const hide = () => {
      window.clearTimeout(timer);
      restore();
      setTooltip(null);
    };

    /** The nearest ancestor carrying a non-empty `title`. */
    const findTarget = (node: EventTarget | null): HTMLElement | null => {
      if (!(node instanceof Element)) return null;
      const element = node.closest<HTMLElement>("[title]");
      return element && element.getAttribute("title")?.trim() ? element : null;
    };

    const show = (element: HTMLElement, immediate: boolean, pointer?: { x: number; y: number }) => {
      const text = element.getAttribute("title")?.trim();
      // A tooltip repeating text the reader can already see is suppressed; see
      // tooltip-visibility for the rule.
      if (!text || isTooltipRedundant(measureElement(element), text)) return;
      const reveal = () => {
        const rect = element.getBoundingClientRect();
        // Sit just below the POINTER, the way a native tooltip does, so on a wide
        // row it appears where the user is looking instead of at the element's
        // centre. Keyboard focus has no pointer, so it falls back to the anchor.
        const origin = pointer ?? { x: rect.left + rect.width / 2, y: rect.bottom };
        // Suppress the native bubble only now, so the attribute is present for
        // assistive tech right up to the moment our own tooltip replaces it.
        element.dataset.tooltip = text;
        element.removeAttribute("title");
        stripped = element;
        setTooltip({ text, x: origin.x, y: origin.y, anchorTop: rect.top });
      };
      window.clearTimeout(timer);
      if (immediate) {
        reveal();
      } else {
        timer = window.setTimeout(reveal, HOVER_DELAY_MS);
      }
    };

    const onPointerOver = (event: PointerEvent) => {
      const element = findTarget(event.target);
      if (!element) {
        // Left the anchor for something without a title.
        if (stripped && !stripped.contains(event.target as Node)) hide();
        return;
      }
      if (element === stripped) return;
      hide();
      show(element, false, { x: event.clientX, y: event.clientY });
    };

    const onFocusIn = (event: FocusEvent) => {
      const element = findTarget(event.target);
      // Keyboard focus shows it at once: there is no "resting" gesture to wait for.
      if (element) show(element, true);
    };

    // Any of these means the tooltip is no longer describing what the user is
    // pointing at, so it goes away rather than lingering over new content.
    const onScroll = () => hide();

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", hide, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("blur", hide);

    return () => {
      window.clearTimeout(timer);
      // Never leave an element without the attribute it started with.
      restore();
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", hide, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (!tooltip) {
    return null;
  }

  return createPortal(
    <TooltipBubble text={tooltip.text} x={tooltip.x} y={tooltip.y} anchorTop={tooltip.anchorTop} />,
    document.body,
  );
}
