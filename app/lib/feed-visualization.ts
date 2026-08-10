import type { ThemeMode } from "@/app/lib/use-theme";

interface FeedVisualizationMeta {
  feedId: string;
  feedName: string;
  theme: ThemeMode;
  createdAt: number;
}

export type FeedVisualization = FeedVisualizationMeta & (
  | { kind: "mermaid"; source: string }
  | { kind: "image"; src: string; alt: string }
  | { kind: "code"; source: string; language: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
);

export const FEED_VISUALIZATION_STORAGE_PREFIX = "stacks-feed-visualization:";

export function contentFingerprint(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function feedVisualizationId(kind: FeedVisualization["kind"], feedId: string, content: string): string {
  return `${kind}-${feedId}-${contentFingerprint(content)}`;
}

export function storeFeedVisualization(id: string, visualization: FeedVisualization): void {
  window.localStorage.setItem(`${FEED_VISUALIZATION_STORAGE_PREFIX}${id}`, JSON.stringify(visualization));
}

export function readFeedVisualization(id: string): FeedVisualization | null {
  const stored = window.localStorage.getItem(`${FEED_VISUALIZATION_STORAGE_PREFIX}${id}`);
  if (!stored) return null;
  try {
    const value = JSON.parse(stored) as Partial<FeedVisualization>;
    if ((value.theme !== "dark" && value.theme !== "light") || typeof value.createdAt !== "number") return null;
    const meta = {
      feedId: typeof value.feedId === "string" ? value.feedId : "",
      feedName: typeof value.feedName === "string" && value.feedName.trim() ? value.feedName.trim() : "AI feed",
      theme: value.theme,
      createdAt: value.createdAt,
    };
    if (value.kind === "mermaid" && typeof value.source === "string") return { ...meta, kind: value.kind, source: value.source };
    if (value.kind === "image" && typeof value.src === "string" && typeof value.alt === "string") return { ...meta, kind: value.kind, src: value.src, alt: value.alt };
    if (value.kind === "code" && typeof value.source === "string" && typeof value.language === "string") return { ...meta, kind: value.kind, source: value.source, language: value.language };
    if (value.kind === "table" && Array.isArray(value.headers) && value.headers.every((cell) => typeof cell === "string") && Array.isArray(value.rows) && value.rows.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) {
      return { ...meta, kind: value.kind, headers: value.headers, rows: value.rows };
    }
  } catch {
    return null;
  }
  return null;
}
