"use client";

import { useRef } from "react";

/**
 * A bordered textarea with a synchronized, read-only syntax-highlight layer
 * behind it — the same technique the prompt-template editor uses, so summaries,
 * abstracts, notes, and prompts all get markdown + LaTeX highlighting while
 * staying plain editable text. Set `variables` to also highlight `{{tokens}}`
 * (used by the prompt editors); omit it for plain markdown fields.
 */

const MARKDOWN_TOKEN_RE = /(^#{1,6}\s.+$|`[^`\n]+`|\${1,2}[^$\n]+\${1,2}|\*\*[^*\n]+\*\*|(?<![*\w])\*[^*\n]+\*)/gm;
const VARIABLE_TOKEN_RE = /(\{\{[a-zA-Z0-9_]+(?:\[[^\]]*\])?\}\}|^#{1,6}\s.+$|`[^`\n]+`|\${1,2}[^$\n]+\${1,2})/gm;

function tokenClass(part: string): string | undefined {
  if (/^\{\{.+\}\}$/.test(part)) return "is-variable";
  if (/^#{1,6}\s/.test(part)) return "is-heading";
  if (/^`.+`$/.test(part)) return "is-code";
  if (/^\${1,2}.+\${1,2}$/.test(part)) return "is-math";
  if (/^\*\*.+\*\*$/.test(part)) return "is-strong";
  if (/^\*.+\*$/.test(part)) return "is-emphasis";
  return undefined;
}

export function MarkdownCodeEditor({
  value,
  onChange,
  ariaLabel,
  placeholder,
  rows = 5,
  name,
  variables = false,
  textareaRef,
}: {
  value: string;
  onChange?: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  rows?: number;
  name?: string;
  /** Highlight {{tokens}} too (prompt editors); default is plain markdown. */
  variables?: boolean;
  textareaRef?: (node: HTMLTextAreaElement | null) => void;
}) {
  const highlightLayer = useRef<HTMLPreElement | null>(null);
  const pattern = variables ? VARIABLE_TOKEN_RE : MARKDOWN_TOKEN_RE;
  const parts = value.split(pattern);

  return (
    <div className="prompt-code-editor" style={{ minHeight: `${rows * 1.6 + 1.4}em` }}>
      <pre ref={highlightLayer} aria-hidden="true">
        {parts.map((part, index) => (
          <span className={tokenClass(part)} key={`${index}-${part.slice(0, 12)}`}>{part}</span>
        ))}
        {value.endsWith("\n") ? "\n" : null}
      </pre>
      <textarea
        ref={textareaRef}
        name={name}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        onScroll={(event) => {
          if (!highlightLayer.current) return;
          highlightLayer.current.scrollTop = event.currentTarget.scrollTop;
          highlightLayer.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        spellCheck={false}
        rows={rows}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </div>
  );
}
