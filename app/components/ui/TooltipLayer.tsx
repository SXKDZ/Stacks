"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

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
/** Gap between the anchor and the tooltip. */
const OFFSET = 8;

interface TooltipState {
  text: string;
  /** Anchor rect, in viewport coordinates. */
  anchor: { top: number; bottom: number; left: number; right: number };
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

    const show = (element: HTMLElement, immediate: boolean) => {
      const text = element.getAttribute("title")?.trim();
      if (!text) return;
      const reveal = () => {
        const rect = element.getBoundingClientRect();
        // Suppress the native bubble only now, so the attribute is present for
        // assistive tech right up to the moment our own tooltip replaces it.
        element.dataset.tooltip = text;
        element.removeAttribute("title");
        stripped = element;
        setTooltip({
          text,
          anchor: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        });
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
      show(element, false);
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

  // Prefer below the anchor; flip above when there isn't room, and clamp
  // horizontally so a tooltip on a screen-edge control stays fully visible.
  const below = tooltip.anchor.bottom + OFFSET;
  const flip = below + 44 > window.innerHeight;
  const style: React.CSSProperties = flip
    ? { bottom: window.innerHeight - tooltip.anchor.top + OFFSET }
    : { top: below };
  const centre = (tooltip.anchor.left + tooltip.anchor.right) / 2;

  return createPortal(
    <div
      className="app-tooltip"
      role="tooltip"
      aria-hidden="true"
      style={{ ...style, left: centre, ["--tooltip-shift" as string]: "-50%" }}
    >
      {tooltip.text}
    </div>,
    document.body,
  );
}
