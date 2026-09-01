"use client";

import { Children, cloneElement, isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { FeedCodeBlock, FeedImage, FeedTable } from "@/app/components/FeedRichContent";
import { MermaidDiagram } from "@/app/components/MermaidDiagram";

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
        .replace(/\\\[([\s\S]*?)\\\]/g, (_, expression: string) => `\n\n$$\n${expression.trim()}\n$$\n\n`)
        .replace(/\\\((.*?)\\\)/g, (_, expression: string) => `$${expression.trim()}$`)
        // remark-math only treats $$…$$ as *display* math when the fences sit on
        // their own lines. Agents routinely write $$…$$ inline, which parses as
        // inline math (small, left-aligned), so hoist any inline $$…$$ onto its
        // own lines to render as a centered display block.
        .replace(/(^|[^$])\$\$([^$\n][\s\S]*?)\$\$(?!\$)/g, (_, before: string, expression: string) => `${before}\n\n$$\n${expression.trim()}\n$$\n\n`);
    })
    .join("");
}

// Parsing runs remark/rehype (math + syntax highlighting) plus a regex
// normalization pass, so it is comparatively expensive. Memoize on the
// primitive props so an unrelated parent re-render (e.g. typing in the feed
// search box) never re-parses an unchanged thread.
function mermaidSource(children: ReactNode): string | null {
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null;
  if (!child.props.className?.split(/\s+/).includes("language-mermaid")) return null;
  return String(child.props.children ?? "").replace(/\n$/, "");
}

function splitHighlightedNode(node: ReactNode, key: string): ReactNode[][] {
  if (typeof node === "string" || typeof node === "number") {
    return String(node).split("\n").map((part) => [part]);
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return [[node]];
  return splitHighlightedChildren(node.props.children).map((line, index) => [
    cloneElement(node, { key: `${key}-${index}` }, line),
  ]);
}

function splitHighlightedChildren(children: ReactNode): ReactNode[][] {
  const lines: ReactNode[][] = [[]];
  Children.toArray(children).forEach((child, childIndex) => {
    const parts = splitHighlightedNode(child, `code-token-${childIndex}`);
    lines.at(-1)?.push(...parts[0]);
    parts.slice(1).forEach((part) => lines.push([...part]));
  });
  return lines;
}

function HighlightedCodeLines({ children, className, showLineNumbers, wrapLines, ...props }: {
  children: ReactNode;
  className?: string;
  showLineNumbers: boolean;
  wrapLines: boolean;
}) {
  if (!showLineNumbers && !wrapLines) return <code className={className} {...props}>{children}</code>;
  const lines = splitHighlightedChildren(children);
  if (lines.length > 1 && lines.at(-1)?.every((part) => part === "")) lines.pop();
  return (
    <code className={className} {...props}>
      <span className="code-visualization-lines">
        {lines.map((line, index) => (
          <span className="code-visualization-line" key={`code-line-${index}`}>
            {line}
          </span>
        ))}
      </span>
    </code>
  );
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  className = "",
  feedId,
  feedName,
  showCodeLineNumbers = false,
  wrapCodeLines = false,
}: {
  content: string;
  className?: string;
  // The feed's rich content (Mermaid, focused viewers) needs a feed to attach
  // its visualizations to, so `feedId` alone decides whether it renders.
  feedId?: string;
  feedName?: string;
  showCodeLineNumbers?: boolean;
  wrapCodeLines?: boolean;
}) {
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
          pre: ({ children, node, ...props }) => {
            void node;
            if (feedId) {
              const source = mermaidSource(children);
              if (source !== null) return <MermaidDiagram source={source} feedId={feedId} feedName={feedName ?? "AI feed"} />;
              return <FeedCodeBlock feedId={feedId} feedName={feedName ?? "AI feed"} {...props}>{children}</FeedCodeBlock>;
            }
            return <pre {...props}>{children}</pre>;
          },
          code: ({ children, className, node, ...props }) => {
            void node;
            return (
              <HighlightedCodeLines
                className={className}
                showLineNumbers={showCodeLineNumbers}
                wrapLines={wrapCodeLines}
                {...props}
              >
                {children}
              </HighlightedCodeLines>
            );
          },
          table: ({ children, node, ...props }) => {
            void node;
            return feedId ? (
              <FeedTable feedId={feedId} feedName={feedName ?? "AI feed"} {...props}>{children}</FeedTable>
            ) : (
              <div className="markdown-media markdown-table-scroll">
                <table {...props}>{children}</table>
              </div>
            );
          },
          img: ({ node, alt = "", ...props }) => {
            void node;
            return feedId ? (
              <FeedImage feedId={feedId} feedName={feedName ?? "AI feed"} alt={alt} {...props} />
            ) : (
              <span className="markdown-media markdown-image">
                <img alt={alt} {...props} />
              </span>
            );
          },
        }}
      >
        {normalizeLatexDelimiters(content)}
      </ReactMarkdown>
    </div>
  );
});
