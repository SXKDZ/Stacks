import { and, asc, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedGithubOutbox } from "@/db/schema";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import { patchIssueState, GitHubError, GitHubSyncDeferred, type GitHubConfig } from "@/app/lib/github-sync";

/**
 * A small durable outbox for GitHub actions that must reach the repo even when
 * the app is offline or a sync is mid-flight. Today it carries one op:
 * "close-issue", enqueued when a mirrored feed is deleted (deletion has to reach
 * GitHub, or inbound sync would recreate the feed from its still-open issue).
 *
 * Each op records the repo it targets, so switching repos never fires a stale
 * close at the wrong one. The queue is drained on delete, at sync start, and on
 * startup; a failed op stays queued (with its error) and is retried next time.
 */

const CLOSE_ISSUE = "close-issue";

/** Queue "close this issue" for the active repo. No-op if the repo is unknown. */
export async function enqueueCloseIssue(issueNumber: number): Promise<void> {
  const runtime = await resolveRuntimeValues();
  const repo = runtimeValue(runtime, "STACKS_GITHUB_REPO");
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
