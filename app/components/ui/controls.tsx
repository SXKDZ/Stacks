"use client";

import { Check, CheckCircle2, ChevronDown, Clock3, Inbox, X } from "lucide-react";
import { cva } from "class-variance-authority";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { twMerge } from "tailwind-merge";

export type ActionVariant = "primary" | "secondary" | "ghost" | "danger" | "success" | "light" | "brand-ghost" | "on-dark";
export type ActionSize = "small" | "medium" | "large" | "icon" | "icon-small" | "icon-large";

export function cx(...values: Array<string | false | null | undefined>) {
  return twMerge(values.filter(Boolean).join(" "));
}

const actionVariants = cva(
  [
    "inline-flex shrink-0 select-none items-center justify-center gap-2",
    "rounded-[var(--radius-lg)] border font-semibold leading-[1.25] no-underline",
    "transition-[background-color,border-color,color,box-shadow,filter,transform] duration-200 ease-out",
    "hover:-translate-y-px active:translate-y-0 active:scale-[0.97]",
    "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[color-mix(in_srgb,var(--brand-blue)_22%,transparent)]",
    "disabled:pointer-events-none disabled:opacity-50 disabled:transform-none",
  ],
  {
    variants: {
      variant: {
        primary: [
          "border-white/10 bg-[image:var(--brand-gradient)] text-white shadow-[0_10px_24px_rgba(37,126,222,0.24),inset_0_1px_0_rgba(255,255,255,0.18)]",
          "hover:border-white/20 hover:brightness-110 hover:shadow-[0_14px_30px_rgba(37,126,222,0.32),inset_0_1px_0_rgba(255,255,255,0.22)]",
        ],
        secondary: [
          "border-[var(--line-strong)] bg-[var(--surface-1)] text-[var(--ink)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
          "hover:border-[color-mix(in_srgb,var(--brand-blue)_38%,var(--line-strong))] hover:bg-[color-mix(in_srgb,var(--brand-blue)_8%,var(--surface-1))] hover:text-[var(--brand-blue-strong)]",
        ],
        ghost: [
          "border-transparent bg-transparent text-[var(--muted)]",
          "hover:border-[var(--line)] hover:bg-[color-mix(in_srgb,var(--ink)_6%,transparent)] hover:text-[var(--ink)]",
        ],
        danger: [
          "border-[color-mix(in_srgb,var(--rose)_28%,var(--line-strong))] bg-[color-mix(in_srgb,var(--rose)_6%,transparent)] text-[var(--rose)]",
          "hover:border-[color-mix(in_srgb,var(--rose)_48%,var(--line-strong))] hover:bg-[var(--rose-soft)] hover:shadow-[0_10px_24px_color-mix(in_srgb,var(--rose)_12%,transparent)]",
        ],
        success: [
          "border-[color-mix(in_srgb,var(--green)_40%,transparent)] bg-[var(--green-soft)] text-[var(--green)]",
        ],
        light: [
          "border-[rgba(16,19,26,0.14)] bg-white text-[#10131a] shadow-[0_1px_2px_rgba(16,19,26,0.06)]",
          "hover:border-[rgba(16,19,26,0.22)] hover:bg-[#f3f6f9]",
        ],
        "brand-ghost": [
          "border-[color-mix(in_srgb,var(--brand-blue)_24%,transparent)] bg-[var(--brand-blue-soft)] text-[var(--brand-blue-strong)]",
          "hover:border-[color-mix(in_srgb,var(--brand-blue)_40%,transparent)] hover:bg-[color-mix(in_srgb,var(--brand-blue)_18%,transparent)]",
        ],
        "on-dark": [
          "border-white/15 bg-white/[0.07] text-[#f2f5f8] shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]",
          "hover:border-white/25 hover:bg-white/[0.13]",
        ],
      },
      size: {
        large: "h-11 px-[18px] text-[length:var(--type-body)]",
        medium: "h-10 px-3.5 text-[length:var(--type-control)]",
        small: "h-[34px] px-2.5 text-[length:var(--type-control)]",
        icon: "size-10 p-0",
        "icon-small": "size-8 p-0",
        "icon-large": "size-11 p-0",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "medium",
    },
  },
);

function actionClassName(variant: ActionVariant, size: ActionSize, className?: string) {
  return cx(actionVariants({ variant, size, className }));
}

/** The small keyboard-shortcut badge shown at the trailing edge of a button. */
export function KeyHint({ children }: { children: ReactNode }) {
  return <kbd className="action-kbd" aria-hidden="true">{children}</kbd>;
}

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ActionVariant;
  size?: ActionSize;
  icon?: ReactNode;
  /** A keyboard-shortcut hint rendered as a trailing badge (e.g. "R"). */
  kbd?: ReactNode;
}

export function ActionButton({
  variant = "secondary",
  size = "medium",
  icon,
  kbd,
  className,
  children,
  type = "button",
  ...props
}: ActionButtonProps) {
  return (
    <button type={type} className={actionClassName(variant, size, className)} {...props}>
      {icon ? (
        <span className="flex size-[17px] shrink-0 items-center justify-center [&_svg]:size-[17px] [&_svg]:stroke-2" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children ? <span className="overflow-hidden text-ellipsis whitespace-nowrap">{children}</span> : null}
      {kbd != null ? <KeyHint>{kbd}</KeyHint> : null}
    </button>
  );
}

export interface ActionLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ActionVariant;
  size?: ActionSize;
  icon?: ReactNode;
  kbd?: ReactNode;
}

export function ActionLink({
  variant = "secondary",
  size = "medium",
  icon,
  kbd,
  className,
  children,
  ...props
}: ActionLinkProps) {
  return (
    <a className={actionClassName(variant, size, className)} {...props}>
      {icon ? (
        <span className="flex size-[17px] shrink-0 items-center justify-center [&_svg]:size-[17px] [&_svg]:stroke-2" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children ? <span className="overflow-hidden text-ellipsis whitespace-nowrap">{children}</span> : null}
      {kbd != null ? <KeyHint>{kbd}</KeyHint> : null}
    </a>
  );
}

export type ReadingStatus = "inbox" | "to-read" | "reading" | "complete" | "read" | string;

export function readingStatusLabel(status: ReadingStatus) {
  if (status === "complete" || status === "read") return "Read";
  if (status === "reading") return "Reading";
  return "To read";
}

const statusVariants = cva(
  "status-pill inline-flex w-max items-center justify-center gap-1.5 rounded-full border border-current/10 font-semibold leading-[1.25] [&_svg]:size-[13px] [&_svg]:stroke-2",
  {
    variants: {
      status: {
        reading: "bg-[var(--status-reading-soft)] text-[var(--status-reading)]",
        complete: "bg-[var(--status-complete-soft)] text-[var(--status-complete)]",
        inbox: "bg-[var(--status-inbox-soft)] text-[var(--status-inbox)]",
      },
      compact: {
        true: "size-7 rounded-[var(--radius-pill)] border border-current p-0 text-[length:var(--type-caption)] [&_svg]:size-[15px]",
        false: "h-7 px-2.5 text-[length:var(--type-caption)]",
      },
    },
    defaultVariants: {
      status: "inbox",
      compact: false,
    },
  },
);

export function StatusPill({
  status,
  compact = false,
  className,
}: {
  status: ReadingStatus;
  compact?: boolean;
  className?: string;
}) {
  const label = readingStatusLabel(status);
  const normalizedStatus = status === "read" ? "complete" : status === "to-read" ? "inbox" : status;
  const visualStatus = normalizedStatus === "complete" || normalizedStatus === "reading" ? normalizedStatus : "inbox";
  const Icon = normalizedStatus === "complete" ? CheckCircle2 : normalizedStatus === "reading" ? Clock3 : Inbox;

  return (
    <span
      className={cx(statusVariants({ status: visualStatus, compact, className }))}
      aria-label={label}
      title={compact ? label : undefined}
    >
      <Icon aria-hidden="true" />
      {!compact ? <span>{label}</span> : null}
    </span>
  );
}

/* --- TabButton: pill / underline / nav / segmented tabs and section nav --- */
export type TabVariant = "pill" | "underline" | "segmented" | "nav";

const tabVariants = cva(
  [
    "inline-flex shrink-0 select-none items-center gap-1.5 border font-semibold leading-[1.25]",
    "transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out",
    "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[var(--brand-blue-soft)]",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:stroke-2",
  ],
  {
    variants: {
      variant: {
        pill: "h-[36px] justify-center rounded-[10px] border-transparent bg-transparent px-3 text-[length:var(--type-control)] text-[var(--muted)] hover:bg-[color-mix(in_srgb,var(--ink)_6%,transparent)] hover:text-[var(--ink)]",
        underline: "rounded-t-[var(--radius-md)] border-transparent border-b-2 bg-transparent px-2.5 py-2.5 text-[length:var(--type-control)] text-[var(--muted)] hover:text-[var(--ink)]",
        segmented: "h-[30px] flex-1 justify-center rounded-[9px] border-transparent bg-transparent px-2 text-[length:var(--type-caption)] text-[var(--muted)] hover:text-[var(--ink)]",
        nav: "grid w-full grid-cols-[auto_1fr] items-center gap-2.5 rounded-xl border-transparent bg-transparent p-2.5 text-left text-[var(--muted)] [&_svg]:size-[16px] [&>span]:flex [&>span]:min-w-0 [&>span]:flex-col [&>span]:gap-0.5 [&_strong]:truncate [&_strong]:text-[length:var(--type-caption)] [&_strong]:text-[var(--ink)] [&_small]:truncate [&_small]:text-[length:var(--type-micro)] [&_small]:text-[var(--muted)]",
      },
      active: { true: "", false: "" },
    },
    compoundVariants: [
      {
        variant: "pill",
        active: true,
        className: "border-[color-mix(in_srgb,var(--brand-blue)_25%,transparent)] bg-[var(--brand-blue-soft)] text-[var(--brand-blue-strong)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
      },
      {
        variant: "underline",
        active: true,
        className: "border-b-[var(--brand-blue)] text-[var(--brand-blue-strong)]",
      },
      {
        variant: "segmented",
        active: true,
        className: "border-[var(--line-strong)] bg-[var(--surface-1)] text-[var(--ink)] shadow-[0_5px_16px_rgba(0,0,0,0.14),inset_0_1px_0_rgba(255,255,255,0.05)]",
      },
      {
        variant: "nav",
        active: true,
        className: "border-[color-mix(in_srgb,var(--brand-blue)_26%,transparent)] bg-[var(--brand-blue-soft)] text-[var(--brand-blue-strong)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--brand-blue)_26%,transparent)] [&_strong]:text-[var(--brand-blue-strong)]",
      },
    ],
    defaultVariants: { variant: "pill", active: false },
  },
);

export interface TabButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: TabVariant;
  active?: boolean;
  icon?: ReactNode;
}

export function TabButton({
  variant = "pill",
  active = false,
  icon,
  className,
  children,
  type = "button",
  ...props
}: TabButtonProps) {
  return (
    <button
      type={type}
      aria-pressed={active}
      className={cx(tabVariants({ variant, active, className }))}
      {...props}
    >
      {icon ? <span className="flex shrink-0 items-center" aria-hidden="true">{icon}</span> : null}
      {children}
    </button>
  );
}

/* --- Chip: small pill tag, optionally removable, optionally interactive --- */
const chipVariants = cva(
  "inline-flex w-max items-center gap-1.5 rounded-full border font-semibold leading-[1.25] [&_svg]:size-[13px] [&_svg]:stroke-2",
  {
    variants: {
      tone: {
        brand: "border-[color-mix(in_srgb,var(--brand-blue)_22%,transparent)] bg-[var(--brand-blue-soft)] text-[var(--brand-blue-strong)]",
        neutral: "border-[var(--line-strong)] bg-[var(--surface-1)] text-[var(--muted)]",
      },
      interactive: {
        true: "cursor-pointer transition-[background-color,border-color,color] duration-150 ease-out hover:shadow-[inset_0_0_0_1px_currentColor]",
        false: "",
      },
      size: {
        small: "h-[20px] px-1.5 text-[length:var(--type-micro)]",
        medium: "h-7 px-2.5 text-[length:var(--type-caption)]",
      },
    },
    defaultVariants: { tone: "brand", interactive: false, size: "medium" },
  },
);

export interface ChipProps {
  tone?: "brand" | "neutral";
  size?: "small" | "medium";
  icon?: ReactNode;
  onRemove?: () => void;
  removeIcon?: ReactNode;
  removeLabel?: string;
  onClick?: () => void;
  className?: string;
  title?: string;
  children: ReactNode;
}

export function Chip({ tone = "brand", size = "medium", icon, onRemove, removeIcon, removeLabel, onClick, className, title, children }: ChipProps) {
  const interactive = Boolean(onClick);
  const content = (
    <>
      {icon ? <span className="flex shrink-0 items-center" aria-hidden="true">{icon}</span> : null}
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{children}</span>
    </>
  );
  if (onRemove) {
    return (
      <span className={cx(chipVariants({ tone, size, interactive: false, className }))} title={title}>
        {content}
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="ml-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full text-current opacity-70 transition-opacity hover:opacity-100 [&_svg]:size-[12px] [&_svg]:stroke-2"
        >
          {removeIcon}
        </button>
      </span>
    );
  }
  if (interactive) {
    return (
      <button type="button" onClick={onClick} title={title} className={cx(chipVariants({ tone, size, interactive: true, className }))}>
        {content}
      </button>
    );
  }
  return <span className={cx(chipVariants({ tone, size, interactive: false, className }))} title={title}>{content}</span>;
}

/** A collection chip: a neutral Chip carrying the collection's accent color as a
 *  leading dot (via the swatch-<color> class). One source for every place a
 *  collection is shown as a chip — paper rows, the detail drawer, the tag editor. */
export function CollectionChip({ name, color, size, onClick, onRemove }: {
  name: string;
  color: string;
  size?: "small" | "medium";
  onClick?: () => void;
  onRemove?: () => void;
}) {
  return (
    <Chip
      tone="neutral"
      size={size}
      className={`collection-chip swatch-${color}`}
      icon={<span className="collection-chip-dot" />}
      onClick={onClick}
      onRemove={onRemove}
      removeIcon={onRemove ? <X /> : undefined}
      removeLabel={onRemove ? `Remove ${name}` : undefined}
    >{name}</Chip>
  );
}

/* --- TextButton: borderless inline text action, optional link underline --- */
const textButtonVariants = cva(
  [
    "inline-flex items-center gap-1 border-0 bg-transparent p-0 font-bold leading-[1.25]",
    "transition-colors duration-150 ease-out",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-blue-soft)] focus-visible:ring-offset-2",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:size-[14px] [&_svg]:shrink-0 [&_svg]:stroke-2",
  ],
  {
    variants: {
      tone: {
        brand: "text-[var(--brand-blue-strong)] hover:text-[var(--brand-blue)]",
        danger: "text-[var(--rose)] hover:opacity-80",
        muted: "text-[var(--muted)] hover:text-[var(--ink)]",
      },
      link: {
        true: "underline decoration-transparent underline-offset-2 hover:decoration-current",
        false: "",
      },
    },
    defaultVariants: { tone: "brand", link: false },
  },
);

export interface TextButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: "brand" | "danger" | "muted";
  link?: boolean;
  icon?: ReactNode;
  trailingIcon?: ReactNode;
}

export function TextButton({ tone = "brand", link = false, icon, trailingIcon, className, children, type = "button", ...props }: TextButtonProps) {
  return (
    <button type={type} className={cx(textButtonVariants({ tone, link, className }))} {...props}>
      {icon}
      {children ? <span className="overflow-hidden text-ellipsis">{children}</span> : null}
      {trailingIcon}
    </button>
  );
}

/* --- SelectCard: icon + title + description option card (radio/action) --- */
const selectCardVariants = cva(
  [
    "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[var(--radius-control)] border p-3 text-left",
    "transition-[background-color,border-color,box-shadow] duration-150 ease-out",
    "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[var(--brand-blue-soft)]",
    "disabled:pointer-events-none disabled:opacity-50",
  ],
  {
    variants: {
      selected: {
        true: "border-[var(--brand-blue)] bg-[color-mix(in_srgb,var(--brand-blue)_9%,transparent)] text-[var(--ink)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--brand-blue)_10%,transparent)]",
        false: "border-[var(--line-strong)] bg-[var(--panel)] text-[var(--muted)] hover:border-[color-mix(in_srgb,var(--brand-blue)_30%,var(--line-strong))] hover:bg-[var(--brand-blue-soft)]",
      },
    },
    defaultVariants: { selected: false },
  },
);

export interface SelectCardProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  selected?: boolean;
  trailing?: ReactNode;
}

export function SelectCard({ icon, title, description, selected = false, trailing, className, type = "button", ...props }: SelectCardProps) {
  return (
    <button type={type} aria-pressed={selected} className={cx(selectCardVariants({ selected, className }))} {...props}>
      {icon ? <span className="flex size-[18px] shrink-0 items-center justify-center [&_svg]:size-[18px] [&_svg]:stroke-2" aria-hidden="true">{icon}</span> : <span />}
      <span className="flex min-w-0 flex-col gap-0.5">
        <strong className="truncate text-[length:var(--type-control)] text-[var(--ink)]">{title}</strong>
        {description ? <small className="truncate text-[length:var(--type-micro)] text-[var(--muted)]">{description}</small> : null}
      </span>
      {trailing ? <span className="flex shrink-0 items-center text-[var(--brand-blue)] [&_svg]:size-[15px] [&_svg]:stroke-2" aria-hidden="true">{trailing}</span> : <span />}
    </button>
  );
}

/* --- Scrim: full-bleed overlay click-catcher behind modals/drawers --- */
export function Scrim({
  onClick,
  label,
  fixed = false,
  className,
}: {
  onClick: () => void;
  label: string;
  fixed?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cx(
        fixed ? "fixed" : "absolute",
        "inset-0 h-full w-full cursor-default border-0 bg-[var(--scrim)] backdrop-blur-[2px]",
        className,
      )}
    />
  );
}

/* --- PaginationButton: dense pager control (prev/next/page-number) --- */
const paginationVariants = cva(
  [
    "inline-flex shrink-0 select-none items-center justify-center border font-semibold leading-[1.25]",
    "transition-[background-color,border-color,color] duration-150 ease-out",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-blue-soft)]",
    "disabled:pointer-events-none disabled:opacity-40",
    "[&_svg]:stroke-2",
  ],
  {
    variants: {
      current: {
        true: "border-white/10 bg-[image:var(--brand-gradient)] text-white",
        false: "border-[var(--line)] bg-[var(--panel)] text-[var(--muted)] hover:border-[color-mix(in_srgb,var(--brand-blue)_34%,var(--line))] hover:bg-[var(--brand-blue-soft)] hover:text-[var(--brand-blue-strong)]",
      },
      compact: {
        true: "min-h-[25px] min-w-[25px] rounded-[var(--radius-md)] px-1 text-[length:var(--type-micro)]",
        false: "min-h-[30px] min-w-[30px] rounded-[var(--radius-md)] px-1.5 text-[length:var(--type-caption)]",
      },
    },
    defaultVariants: { current: false, compact: false },
  },
);

export interface PaginationButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  current?: boolean;
  compact?: boolean;
}

export function PaginationButton({ current = false, compact = false, className, children, type = "button", ...props }: PaginationButtonProps) {
  return (
    <button type={type} className={cx(paginationVariants({ current, compact, className }))} {...props}>
      {children}
    </button>
  );
}

/** One option in a {@link Select}. */
export interface SelectOption {
  value: string;
  label: ReactNode;
  /** Optional plain-text label used for the trigger when `label` is a node. */
  text?: string;
}

/**
 * The app's one dropdown control. A native <select> can't style its option
 * popup (it always falls back to the OS list), so this is a custom listbox: a
 * bordered trigger plus a portaled menu using the app's own menu chrome, with a
 * checkmark on the selected option. Used everywhere a select is needed — feed
 * model picker, settings, filter builder, pagination, entity forms.
 *
 * The menu flips above the trigger when there isn't room below, and dismisses on
 * outside click, Escape, or resize — and on scroll ONLY when the scroll happens
 * outside the menu, so scrolling a long option list doesn't close it.
 */
export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = "Select…",
  size = "medium",
  className,
  disabled = false,
  name,
  leadingIcon,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  placeholder?: string;
  size?: "small" | "medium";
  className?: string;
  disabled?: boolean;
  /** Emit a hidden input so the value posts with a native <form>. */
  name?: string;
  /** Optional icon shown at the start of the trigger (e.g. a model chip). */
  leadingIcon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const selected = options.find((option) => option.value === value);
  const triggerLabel = selected ? (selected.text ?? selected.label) : placeholder;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    const dismiss = () => setOpen(false);
    // Scroll closes the menu only when the scroll target is OUTSIDE it —
    // scrolling the option list itself must not dismiss it.
    const onScroll = (event: Event) => {
      if (listRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  function toggle() {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.max(rect.width, 200);
      // Open below the trigger, but flip above when the menu would run past the
      // viewport bottom, so the options are never clipped.
      const estimated = Math.min(options.length * 38 + 12, 460);
      if (rect.bottom + 6 + estimated > window.innerHeight && rect.top - 6 > estimated) {
        setPos({ bottom: window.innerHeight - rect.top + 6, left: rect.left, width });
      } else {
        setPos({ top: rect.bottom + 6, left: rect.left, width });
      }
    }
    setOpen(true);
  }

  function pick(next: string) {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <span className={cx("app-select", className)}>
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <button
        ref={triggerRef}
        type="button"
        className={cx("app-select-trigger", size === "small" && "app-select-trigger-sm")}
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        {leadingIcon}
        <span className="app-select-label">{triggerLabel}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={listRef}
              className="app-select-menu"
              role="listbox"
              id={listboxId}
              aria-label={ariaLabel}
              style={{ position: "fixed", top: pos.top, bottom: pos.bottom, left: pos.left, minWidth: pos.width }}
            >
              {options.map((option) => {
                const isSelected = option.value === value;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    key={option.value}
                    className={cx("app-select-option", isSelected && "is-selected")}
                    onClick={() => pick(option.value)}
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
