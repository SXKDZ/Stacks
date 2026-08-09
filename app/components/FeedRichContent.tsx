"use client";

import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useTheme } from "@/app/lib/use-theme";
import { feedVisualizationId, storeFeedVisualization } from "@/app/lib/feed-visualization";

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function OpenInNewWindow({ id, prepare }: { id: string; prepare: () => void }) {
  return (
    <a
      href={`/feed/visualization?id=${encodeURIComponent(id)}`}
      target="_blank"
      rel="noreferrer"
      className="feed-rich-action"
      aria-label="Open in new window"
      onClick={prepare}
    >
      <ExternalLink aria-hidden="true" />
    </a>
  );
}

function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 1600);
  };
  return { copied, copy };
}

export function FeedCodeBlock({
  feedId,
  feedName,
  children,
  ...props
}: ComponentPropsWithoutRef<"pre"> & { feedId: string; feedName: string }) {
  const { theme } = useTheme();
  const source = useMemo(() => nodeText(children).replace(/\n$/, ""), [children]);
  const child = Children.toArray(children)[0];
  const language = isValidElement<{ className?: string }>(child)
    ? child.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? ""
    : "";
  const id = useMemo(() => feedVisualizationId("code", feedId, `${language}\n${source}`), [feedId, language, source]);
  const { copied, copy } = useCopyFeedback();

  return (
    <div className="feed-rich-content feed-rich-code">
      <div className="feed-rich-actions">
        <button type="button" className="feed-rich-action" aria-label={copied ? "Code copied" : "Copy code"} onClick={() => void copy(source)}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
        <OpenInNewWindow
          id={id}
          prepare={() => storeFeedVisualization(id, { kind: "code", source, language, feedId, feedName, theme, createdAt: Date.now() })}
        />
      </div>
      <pre {...props}>{children}</pre>
      <span className="sr-only" role="status" aria-live="polite">{copied ? "Code copied to clipboard" : ""}</span>
    </div>
  );
}

export function FeedImage({ feedId, feedName, alt = "", src = "", ...props }: ComponentPropsWithoutRef<"img"> & { feedId: string; feedName: string }) {
  const { theme } = useTheme();
  const source = typeof src === "string" ? src : "";
  const id = useMemo(() => feedVisualizationId("image", feedId, source), [feedId, source]);
  return (
    <span className="feed-rich-content feed-rich-image">
      <span className="feed-rich-actions">
        <OpenInNewWindow
          id={id}
          prepare={() => storeFeedVisualization(id, { kind: "image", src: source, alt, feedId, feedName, theme, createdAt: Date.now() })}
        />
      </span>
      <img src={source} alt={alt} {...props} />
    </span>
  );
}

export function FeedTable({ feedId, feedName, children, ...props }: ComponentPropsWithoutRef<"table"> & { feedId: string; feedName: string }) {
  const { theme } = useTheme();
  const tableRef = useRef<HTMLTableElement | null>(null);
  const fingerprint = useMemo(() => nodeText(children), [children]);
  const id = useMemo(() => feedVisualizationId("table", feedId, fingerprint), [feedId, fingerprint]);

  const prepare = () => {
    const table = tableRef.current;
    if (!table) return;
    let headers = Array.from(table.querySelectorAll("thead th"), (cell) => cell.textContent?.trim() ?? "");
    let rowElements = Array.from(table.querySelectorAll("tbody tr"));
    if (!headers.length) {
      const allRows = Array.from(table.querySelectorAll("tr"));
      headers = Array.from(allRows[0]?.querySelectorAll("th, td") ?? [], (cell) => cell.textContent?.trim() ?? "");
      rowElements = allRows.slice(1);
    }
    const rows = rowElements.map((row) => Array.from(row.querySelectorAll("th, td"), (cell) => cell.textContent?.trim() ?? ""));
    storeFeedVisualization(id, { kind: "table", headers, rows, feedId, feedName, theme, createdAt: Date.now() });
  };

  return (
    <div className="feed-rich-content feed-rich-table">
      <div className="feed-rich-actions"><OpenInNewWindow id={id} prepare={prepare} /></div>
      <div className="feed-rich-table-scroll">
        <table ref={tableRef} {...props}>{children}</table>
      </div>
    </div>
  );
}
