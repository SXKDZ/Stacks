export interface FeedStatusSnapshot {
  status: string;
  error: string | null;
  updatedAt: string;
}

const STALE_COMPLETION_ERROR =
  "Agent output ended unexpectedly. Send a follow-up message to continue.\nMore output arrived after this feed was marked finished.";
const LOST_RUN_ERROR =
  "The agent process is no longer running. Send a follow-up message to continue.";

/**
 * Resolve the status shown after polling or reconnecting.
 *
 * A terminal timestamp must be at least as new as every persisted message. If
 * output is newer, an overlapping/orphaned run continued after another run set
 * Done, so presenting that row as completed is misleading. Likewise, a stored
 * running/queued state without a live process is an interrupted run after a
 * server restart, not active work.
 */
export function effectiveFeedStatus<T extends FeedStatusSnapshot>(
  snippet: T,
  latestMessageAt: string | null | undefined,
  running: boolean,
): T {
  if (running) {
    return { ...snippet, status: "running", error: null };
  }

  if (snippet.status === "running" || snippet.status === "queued") {
    return { ...snippet, status: "error", error: LOST_RUN_ERROR };
  }

  const terminalAt = Date.parse(snippet.updatedAt);
  const latestAt = latestMessageAt ? Date.parse(latestMessageAt) : Number.NaN;
  if (snippet.status === "done" && Number.isFinite(latestAt) && Number.isFinite(terminalAt) && latestAt > terminalAt) {
    return { ...snippet, status: "error", error: STALE_COMPLETION_ERROR };
  }

  return snippet;
}
