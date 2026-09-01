export interface FeedStatusSnapshot {
  status: string;
  error: string | null;
  updatedAt: string;
}

const STALE_COMPLETION_ERROR =
  "Agent output ended unexpectedly. Send a follow-up message to continue.\nMore output arrived after this feed was marked finished.";
const LOST_RUN_ERROR =
  "The agent process is no longer running. Send a follow-up message to continue.";

/** Roles an agent run writes. Everything else in a thread is written by the app (a
 *  system note) or by the user, and says nothing about whether a run is loose. */
export const AGENT_MESSAGE_ROLES = ["assistant", "tool"];

/**
 * Resolve the status shown after polling or reconnecting.
 *
 * A terminal timestamp must be at least as new as every message an agent run wrote. If
 * such output is newer, an overlapping/orphaned run continued after another run set
 * Done, so presenting that row as completed is misleading. Likewise, a stored
 * running/queued state without a live process is an interrupted run after a server
 * restart, not active work.
 *
 * `latestMessageAt` must therefore cover ONLY the roles in AGENT_MESSAGE_ROLES.
 * Approving a proposal writes a system note into the thread, and counting that made
 * every feed report a failed turn from the moment of the decision until its next turn
 * ended.
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
