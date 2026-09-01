import { and, asc, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedGithubOutbox, feedGithubRetiredComments } from "@/db/schema";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import { editComment, patchIssueState, GitHubError, GitHubSyncDeferred, type GitHubConfig } from "@/app/lib/github-sync";

/**
 * A small durable outbox for GitHub actions that must reach the repo even when
 * the app is offline or a sync is mid-flight. Two ops:
 *
 *   close-issue  — a mirrored feed was deleted. Deletion has to reach GitHub, or
 *                  inbound sync recreates the feed from its still-open issue.
 *   edit-comment — a mirrored proposal was cut out of its thread, so the comment
 *                  offering it for approval has to stop saying it is pending.
 *
 * Each op records the repo it targets, so switching repos never fires a stale
 * write at the wrong one. The queue is drained on delete, at sync start, and on
 * startup; a failed op stays queued (with its error) and is retried next time.
 *
 * This module also records RETIRED comments: a comment that was mirrored into a
 * thread and then cut out of it. The remote comment stays (one the user wrote on
 * their phone is theirs), but its local message is gone, so the inbound pass would
 * otherwise read it as new and act on a request the user has removed.
 */

const CLOSE_ISSUE = "close-issue";
const EDIT_COMMENT = "edit-comment";

/** The repo every queued op targets, or "" when GitHub sync is not configured. */
async function activeRepo(): Promise<string> {
  const runtime = await resolveRuntimeValues();
  return runtimeValue(runtime, "STACKS_GITHUB_REPO");
}

/** Queue "close this issue" for the active repo. No-op if the repo is unknown. */
export async function enqueueCloseIssue(issueNumber: number): Promise<void> {
  const repo = await activeRepo();
  if (!repo) return;
  const database = await ensureDatabase();
  // Collapse duplicates: one pending close per (repo, issue).
  const existing = database
    .select({ id: feedGithubOutbox.id })
    .from(feedGithubOutbox)
    .where(and(eq(feedGithubOutbox.repo, repo), eq(feedGithubOutbox.op, CLOSE_ISSUE), eq(feedGithubOutbox.issueNumber, issueNumber)))
    .get();
  if (existing) return;
  database
    .insert(feedGithubOutbox)
    .values({ id: `gho-${crypto.randomUUID()}`, repo, op: CLOSE_ISSUE, issueNumber, attempts: 0, createdAt: new Date().toISOString() })
    .run();
}

/** Queue "rewrite this comment" for the active repo. No-op if the repo is unknown. */
export async function enqueueEditComment(issueNumber: number, commentId: number, body: string): Promise<void> {
  const repo = await activeRepo();
  if (!repo) return;
  const database = await ensureDatabase();
  // One pending edit per comment: the newest body wins, so a re-queue replaces.
  database
    .delete(feedGithubOutbox)
    .where(and(eq(feedGithubOutbox.repo, repo), eq(feedGithubOutbox.op, EDIT_COMMENT), eq(feedGithubOutbox.commentId, commentId)))
    .run();
  database
    .insert(feedGithubOutbox)
    .values({ id: `gho-${crypto.randomUUID()}`, repo, op: EDIT_COMMENT, issueNumber, commentId, body, attempts: 0, createdAt: new Date().toISOString() })
    .run();
}

/**
 * Record comments whose local messages have been removed from a thread, so the
 * inbound pass never ingests them again. Idempotent: re-retiring is a no-op.
 */
export async function retireComments(snippetId: string, commentIds: number[]): Promise<void> {
  if (!commentIds.length) return;
  const repo = await activeRepo();
  if (!repo) return;
  const database = await ensureDatabase();
  const now = new Date().toISOString();
  for (const commentId of commentIds) {
    database
      .insert(feedGithubRetiredComments)
      .values({ repo, commentId, snippetId, createdAt: now })
      .onConflictDoNothing()
      .run();
  }
}

/** Every retired comment id for one repo, for the inbound pass to skip. */
export async function retiredCommentIds(repo: string): Promise<Set<number>> {
  const database = await ensureDatabase();
  return new Set(
    database
      .select({ commentId: feedGithubRetiredComments.commentId })
      .from(feedGithubRetiredComments)
      .where(eq(feedGithubRetiredComments.repo, repo))
      .all()
      .map((row) => row.commentId),
  );
}

/**
 * Drain the outbox for the currently-configured repo: run each pending op and
 * remove it on success, or bump its attempt count and record the error on
 * failure (so it retries next flush). Ops for other repos are left untouched.
 * Best-effort when called in the background. A manual sync supplies its shared
 * batch policy and receives the expected "batch complete" signal so it can
 * continue in a fresh request without spending beyond the current budget.
 */
export async function flushGithubOutbox(syncConfig?: GitHubConfig): Promise<void> {
  try {
    const runtime = syncConfig ? null : await resolveRuntimeValues();
    const repo = syncConfig?.repo ?? (runtime ? runtimeValue(runtime, "STACKS_GITHUB_REPO") : "");
    const token = syncConfig?.token ?? (runtime ? runtimeValue(runtime, "GITHUB_TOKEN") : "");
    if (!repo || !token) return;
    const database = await ensureDatabase();
    const pending = database
      .select()
      .from(feedGithubOutbox)
      .where(eq(feedGithubOutbox.repo, repo))
      .orderBy(asc(feedGithubOutbox.createdAt))
      .all();
    if (!pending.length) return;
    const config: GitHubConfig = syncConfig ?? { repo, token };
    for (const item of pending) {
      try {
        if (item.op === CLOSE_ISSUE) {
          await patchIssueState(config, item.issueNumber, "closed");
        } else if (item.op === EDIT_COMMENT && item.commentId !== null && item.body !== null) {
          await editComment(config, item.commentId, item.body);
        }
        // Unknown ops are dropped rather than retried forever.
        database.delete(feedGithubOutbox).where(eq(feedGithubOutbox.id, item.id)).run();
      } catch (error) {
        // A manual bulk-sync pass shares its write budget with the outbox. Stop
        // cleanly at the boundary so the route can return a resumable response;
        // a background flush simply leaves the remaining items queued.
        if (error instanceof GitHubSyncDeferred) {
          if (syncConfig) throw error;
          return;
        }
        // A 404/410 means the issue is already gone: treat as done, don't retry.
        const status = error instanceof GitHubError ? error.status : 0;
        if (status === 404 || status === 410) {
          database.delete(feedGithubOutbox).where(eq(feedGithubOutbox.id, item.id)).run();
          continue;
        }
        database
          .update(feedGithubOutbox)
          .set({ attempts: item.attempts + 1, lastError: error instanceof Error ? error.message : String(error) })
          .where(eq(feedGithubOutbox.id, item.id))
          .run();
      }
    }
  } catch (error) {
    if (syncConfig && error instanceof GitHubSyncDeferred) throw error;
    // Never let a background flush surface an error to its caller.
  }
}
