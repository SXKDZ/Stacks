"use client";

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

function normalizeLatexLists(source: string): string {
  let normalized = source;
  const environments: Array<{ name: string; marker: string }> = [
    { name: "itemize", marker: "-" },
    { name: "enumerate", marker: "1." },
  ];
  for (const environment of environments) {
    const pattern = new RegExp(`\\\\begin\\{${environment.name}\\}([\\s\\S]*?)\\\\end\\{${environment.name}\\}`, "gi");
    normalized = normalized.replace(pattern, (_, body: string) => {
      const items = body
        .split(/\\item(?:\s*\[[^\]]+\])?\s*/i)
        .map((item) => item.replace(/\s*\n\s*/g, " ").trim())
        .filter(Boolean);
      return `\n${items.map((item) => `${environment.marker} ${item}`).join("\n")}\n`;
    });
  }
  return normalized
    .replace(/^\s*\\item\s+/gm, "- ")
    .replace(/\\(?:sub)*section\*?\{([^{}]+)\}/g, "### $1")
    .replace(/\\textbf\{([^{}]+)\}/g, "**$1**")
    .replace(/\\(?:emph|textit)\{([^{}]+)\}/g, "*$1*");
}

function normalizeLatexDelimiters(source: string): string {
  return source
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part) => {
      if (part.startsWith("`")) {
        return part;
      }
      return normalizeLatexLists(part)
        .replace(/\\\[([\s\S]*?)\\\]/g, (_, expression: string) => `\n$$\n${expression.trim()}\n$$\n`)
        .replace(/\\\((.*?)\\\)/g, (_, expression: string) => `$${expression.trim()}$`);
    })
    .join("");
}

export function MarkdownContent({ content, className = "" }: { content: string; className?: string }) {
  return (
    <div className={`markdown-content ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }], [rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        skipHtml
        components={{
          a: ({ href, children, ...props }) => (
            <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>
          ),
        }}
      >
        {normalizeLatexDelimiters(content)}
      </ReactMarkdown>
    </div>
  );
}
