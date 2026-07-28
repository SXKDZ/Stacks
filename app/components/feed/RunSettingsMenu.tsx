"use client";

import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SelectOption } from "@/app/components/ui/controls";

/** One setting the menu exposes: a row that opens its own list of options. */
export interface RunSettingGroup {
  /** Stable key, used to track which row's submenu is open. */
  key: string;
  /** The row's name, e.g. "Model". */
  label: string;
  /** The current value ("" meaning inherited). */
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /**
   * Short text for the collapsed trigger. Omit to keep the group out of it: an
   * inherited value with nothing to inherit has nothing worth spending trigger
   * width on.
   */
  triggerText?: string;
}

type Placement = { top: number; left: number; minWidth: number; maxHeight: number };

const ROW_HEIGHT = 34;
const MENU_PADDING = 12;
/** Kept clear of the viewport edges, so a panel never sits flush against them. */
const EDGE = 8;
const GAP = 6;
const SUBMENU_WIDTH = 210;

/**
 * The height a panel of `count` rows wants, and the height it may actually have.
 *
 * Both numbers come from here and the second is applied as the panel's own
 * max-height, so the height used for positioning and the height rendered can never
 * disagree. They did: the model list's 25 options were positioned as a clamped
 * estimate while the stylesheet allowed a taller panel, and the difference hung off
 * the bottom of the screen.
 *
 * The 460/60vh ceiling matches the shared `.app-select-menu`, so a long list scrolls
 * at the same size here as everywhere else instead of filling the viewport.
 */
function fit(count: number, room: number): number {
  return Math.min(count * ROW_HEIGHT + MENU_PADDING, room, 460, window.innerHeight * 0.6);
}

/** Below the anchor, flipping above when there is more room there. */
function placeBelow(anchor: DOMRect, count: number, minWidth: number): Placement {
  const below = window.innerHeight - EDGE - (anchor.bottom + GAP);
  const above = anchor.top - GAP - EDGE;
  const wanted = fit(count, Math.max(below, above));
  if (wanted <= below || below >= above) {
    return { top: anchor.bottom + GAP, left: anchor.left, minWidth, maxHeight: fit(count, below) };
  }
  const maxHeight = fit(count, above);
  return { top: anchor.top - GAP - maxHeight, left: anchor.left, minWidth, maxHeight };
}

/**
 * Beside the anchor row, aligned near its top and pulled up only as far as needed.
 *
 * Overlapping the row vertically is intended here, so unlike placeBelow this never
 * flips: it slides within the viewport instead.
 */
function placeBeside(row: DOMRect, panel: DOMRect | undefined, count: number): Placement {
  const maxHeight = fit(count, window.innerHeight - EDGE * 2);
  const right = (panel?.right ?? row.right) + 4;
  const left = right + SUBMENU_WIDTH > window.innerWidth
    ? Math.max(EDGE, (panel?.left ?? row.left) - SUBMENU_WIDTH - 4)
    : right;
  return {
    top: Math.min(Math.max(EDGE, row.top - 5), window.innerHeight - EDGE - maxHeight),
    left,
    minWidth: SUBMENU_WIDTH,
    maxHeight,
  };
}

/**
 * The composer's run settings (model, reasoning effort) behind one trigger, each
 * opening a submenu.
 *
 * They were two side-by-side selects. Together they were wide enough to push the
 * send group outside the composer's border while the agent ran, when the row also
 * gains a Stop button and the submit label grows to "Interrupt & send": 106px past
 * the edge at a 1440px viewport, 234px at 980px. Collapsing them into one trigger
 * removes the width instead of trying to squeeze it, and leaves room for a third
 * setting later without revisiting the layout.
 */
export function RunSettingsMenu({ groups, leadingIcon }: { groups: RunSettingGroup[]; leadingIcon?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<Placement | null>(null);
  const [subPos, setSubPos] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);

  function close() {
    setOpen(false);
    setActive(null);
  }

  useEffect(() => {
    if (!open) return;
    const isInside = (target: Node) =>
      triggerRef.current?.contains(target) || menuRef.current?.contains(target) || subRef.current?.contains(target);
    const onMouseDown = (event: MouseEvent) => {
      if (!isInside(event.target as Node)) close();
    };
    // Scrolling the page moves the anchor out from under a fixed panel, so dismiss —
    // unless the scroll is inside the menu's own option list.
    const onScroll = (event: Event) => {
      if (subRef.current?.contains(event.target as Node) || menuRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        // Step out one level at a time, so Escape in a submenu returns to the rows.
        if (active) setActive(null);
        else close();
      } else if (event.key === "Tab") {
        close();
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, active]);

  function toggle() {
    if (open) {
      close();
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setMenuPos(placeBelow(rect, groups.length, Math.max(rect.width, 232)));
    setOpen(true);
  }

  /** Open `group`'s submenu beside its row. */
  function openSub(group: RunSettingGroup, row: HTMLElement) {
    setSubPos(placeBeside(row.getBoundingClientRect(), menuRef.current?.getBoundingClientRect(), group.options.length));
    setActive(group.key);
  }

  const activeGroup = groups.find((group) => group.key === active);
  const triggerParts = groups.map((group) => group.triggerText).filter(Boolean) as string[];

  return (
    <span className="run-settings">
      <button
        ref={triggerRef}
        type="button"
        className="app-select-trigger app-select-trigger-sm run-settings-trigger"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Run settings"
      >
        {leadingIcon}
        {/* The first value reads as the primary one and the rest sit muted after it,
            so the trigger states the run's setup without repeating each row's name. */}
        <span className="app-select-label">
          {triggerParts[0]}
          {triggerParts.slice(1).map((part) => (
            <i key={part}>{part}</i>
          ))}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              className="app-select-menu run-settings-menu"
              role="menu"
              aria-label="Run settings"
              style={{ position: "fixed", top: menuPos.top, left: menuPos.left, minWidth: menuPos.minWidth, maxHeight: menuPos.maxHeight }}
            >
              {groups.map((group) => {
                const selected = group.options.find((option) => option.value === group.value);
                return (
                  <button
                    type="button"
                    role="menuitem"
                    key={group.key}
                    className={`run-settings-row ${active === group.key ? "is-open" : ""}`}
                    aria-haspopup="menu"
                    aria-expanded={active === group.key}
                    onClick={(event) => (active === group.key ? setActive(null) : openSub(group, event.currentTarget))}
                    onMouseEnter={(event) => openSub(group, event.currentTarget)}
                  >
                    <span className="run-settings-row-label">{group.label}</span>
                    <span className="run-settings-row-value">{selected?.text ?? selected?.label ?? "Default"}</span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}

      {activeGroup && subPos
        ? createPortal(
            <div
              ref={subRef}
              className="app-select-menu"
              role="menu"
              aria-label={activeGroup.label}
              style={{ position: "fixed", top: subPos.top, left: subPos.left, minWidth: subPos.minWidth, maxHeight: subPos.maxHeight }}
            >
              {activeGroup.options.map((option) => {
                const isSelected = option.value === activeGroup.value;
                return (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    key={option.value}
                    className={`app-select-option ${isSelected ? "is-selected" : ""}`}
                    onClick={() => {
                      activeGroup.onChange(option.value);
                      close();
                      triggerRef.current?.focus();
                    }}
                  >
                    {isSelected ? <Check size={14} aria-hidden="true" /> : <span className="app-select-check-gap" />}
                    <span>{option.label}</span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
