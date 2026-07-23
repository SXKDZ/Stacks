"use client";

import { useMemo, useRef, type ReactNode } from "react";
import { createLowlight, common } from "lowlight";
import markdown from "highlight.js/lib/languages/markdown";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

/**
 * A bordered textarea with a synchronized, read-only syntax-highlight layer
 * behind it, so summaries, abstracts, notes, prompts, and workflow scripts all
 * get highlighting while staying plain editable text.
 *
 * All highlighting runs through lowlight (highlight.js) and renders with the
 * same .hljs-* theme the Markdown renderer uses:
 *  - `language="javascript"` (workflow editor) uses the stock JS grammar.
 *  - the default is a "prompt" grammar: the real Markdown grammar plus two rules
 *    for `$math$`/`$$math$$` and `{{variables}}` (enabled with `variables`), so
 *    prompt templates highlight without any bespoke tokenizer.
 */

const lowlight = createLowlight(common);

// Prompt-template grammar: Markdown, with LaTeX math and (optionally) {{tokens}}
// layered on top so they win over Markdown's own rules.
function promptGrammar(withVariables: boolean) {
  return (hljs: Parameters<typeof markdown>[0]) => {
    const base = markdown(hljs);
    const contains = [
      { scope: "formula", begin: /\$\$/, end: /\$\$/, relevance: 0 },
      { scope: "formula", begin: /\$/, end: /\$/, relevance: 0 },
      ...(base.contains ?? []),
    ];
    if (withVariables) {
      contains.unshift({ scope: "template-variable", begin: /\{\{[a-zA-Z0-9_]+(?:\[[^\]]*\])?\}\}/ });
    }
    return { name: "prompt", contains };
  };
}
lowlight.register("prompt", promptGrammar(false));
lowlight.register("prompt-vars", promptGrammar(true));

type Language = "markdown" | "javascript";

function grammarFor(language: Language, variables: boolean): string {
  if (language === "javascript") return "javascript";
  return variables ? "prompt-vars" : "prompt";
}

function highlight(value: string, language: Language, variables: boolean): ReactNode {
  const tree = lowlight.highlight(grammarFor(language, variables), value);
  return toJsxRuntime(tree, { Fragment, jsx, jsxs });
}

export function MarkdownCodeEditor({
  value,
  onChange,
  onBlur,
  ariaLabel,
  placeholder,
  rows = 5,
  name,
  variables = false,
  language = "markdown",
  textareaRef,
}: {
  value: string;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  ariaLabel: string;
  placeholder?: string;
  rows?: number;
  name?: string;
  /** Highlight {{tokens}} too (prompt editors); default is plain markdown. */
  variables?: boolean;
  /** Highlight the value as JavaScript (the workflow script editor). */
  language?: Language;
  textareaRef?: (node: HTMLTextAreaElement | null) => void;
}) {
  const highlightLayer = useRef<HTMLPreElement | null>(null);
  const tokens = useMemo(() => highlight(value, language, variables), [value, language, variables]);
  // Reuse .prompt-code-editor wholesale; only its height varies, via a CSS var
  // derived from rows (shared 1.58 line-height at 12px + 26px vertical padding).
  const height = `calc(${rows} * 1.58 * 12px + 26px)`;

  return (
    <div className="prompt-code-editor" style={{ ["--code-editor-height" as string]: height }}>
      <pre ref={highlightLayer} aria-hidden="true">
        {tokens}
        {value.endsWith("\n") ? "\n" : null}
      </pre>
      <textarea
        ref={textareaRef}
        name={name}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        onBlur={onBlur}
        onScroll={(event) => {
          if (!highlightLayer.current) return;
          highlightLayer.current.scrollTop = event.currentTarget.scrollTop;
          highlightLayer.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </div>
  );
}
