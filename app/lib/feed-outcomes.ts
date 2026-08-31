/**
 * Reporting the user's approval decisions back to the agent.
 *
 * A decision is information the agent needs: what it may treat as done, and what
 * it must not retry. Until now the only carrier was the user's next reply, so a
 * decision made and then left alone never reached the agent at all, and the
 * summaries it did carry were every applied/rejected proposal in the thread,
 * repeated on every turn.
 *
 * Each outcome is therefore reported exactly once (`reported_at`), and resolving
 * a proposal while the feed is idle starts one short turn that carries the news.
 * Resolutions are coalesced over a brief window, so approving eight changes in a
 * row is one turn rather than eight, and nothing is sent while a turn is already
 * running: that turn will report them when it ends.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { ensureDatabase } from "@/db/bootstrap";
import { feedProposals, feedSnippets } from "@/db/schema";
import { isFeedRunning, runFeedAgent } from "@/app/lib/feed-agent";
import { buildOutcomePrompt } from "@/app/lib/feed-prompt";

/** How long to wait for further decisions before telling the agent. */
const COALESCE_MS = 1500;

/**
 * How far back a decision is still news. A decision is normally reported within
 * seconds (or by the turn that was running when it was taken), so this only bounds
 * what happens on a library that predates the reported_at column: without it, the
 * first decision taken there would drag every past approval into the prompt.
 */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export interface OutcomeReport {
  ids: string[];
  applied: string[];
  rejected: string[];
  failed: string[];
}

const timersGlobal = globalThis as typeof globalThis & {
  __stacksFeedOutcomeTimers?: Map<string, ReturnType<typeof setTimeout>>;
};
const timers = timersGlobal.__stacksFeedOutcomeTimers ??= new Map<string, ReturnType<typeof setTimeout>>();

function summaryOf(operation: string): string {
  try {
    return (JSON.parse(operation) as { summary?: string }).summary ?? "a change";
  } catch {
    return "a change";
  }
}

/** The decisions this feed has not told the agent about yet, oldest first. */
export async function unreportedOutcomes(snippetId: string): Promise<OutcomeReport> {
  const database = await ensureDatabase();
  const rows = database
    .select()
    .from(feedProposals)
    .where(and(
      eq(feedProposals.snippetId, snippetId),
      isNull(feedProposals.reportedAt),
      inArray(feedProposals.status, ["applied", "rejected", "failed"]),
    ))
    .orderBy(asc(feedProposals.resolvedAt))
    .all();
  const freshest = Date.now() - STALE_AFTER_MS;
  const report: OutcomeReport = { ids: [], applied: [], rejected: [], failed: [] };
  for (const row of rows) {
    const resolvedAt = row.resolvedAt ? Date.parse(row.resolvedAt) : Number.NaN;
    if (Number.isFinite(resolvedAt) && resolvedAt < freshest) {
      // Stale: claim it so it is not considered again, but do not report it.
      report.ids.push(row.id);
      continue;
    }
    report.ids.push(row.id);
    const summary = summaryOf(row.operation);
    if (row.status === "applied") report.applied.push(summary);
    else if (row.status === "rejected") report.rejected.push(summary);
    else report.failed.push(row.resultSummary ? `${summary} (${row.resultSummary})` : summary);
  }
  return report;
}

export function hasOutcomes(report: OutcomeReport): boolean {
  return report.applied.length > 0 || report.rejected.length > 0 || report.failed.length > 0;
}

/** Mark these outcomes as told, so no later prompt repeats them. */
export async function markOutcomesReported(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const database = await ensureDatabase();
  database
    .update(feedProposals)
    .set({ reportedAt: new Date().toISOString() })
    .where(inArray(feedProposals.id, ids))
    .run();
}

/**
 * Tell the agent about this feed's outstanding decisions, in one turn, once the
 * user has stopped deciding. Skipped while a turn is running (it reports them at
 * its end) and for a thread with no agent session yet, where a fork's first turn
 * needs the transcript prompt the reply route builds.
 */
export function scheduleOutcomeReport(snippetId: string): void {
  clearTimeout(timers.get(snippetId));
  timers.set(snippetId, setTimeout(() => {
    timers.delete(snippetId);
    void sendOutcomeReport(snippetId).catch(() => {});
  }, COALESCE_MS));
}

async function sendOutcomeReport(snippetId: string): Promise<void> {
  if (isFeedRunning(snippetId)) return;
  const database = await ensureDatabase();
  const snippet = database.select().from(feedSnippets).where(eq(feedSnippets.id, snippetId)).get();
  if (!snippet?.sessionId) return;
  const report = await unreportedOutcomes(snippetId);
  // Claim even the stale ones, so they are not rescanned on every later decision.
  await markOutcomesReported(report.ids);
  if (!hasOutcomes(report)) return;
  await runFeedAgent({
    snippetId,
    sessionId: snippet.sessionId,
    prompt: buildOutcomePrompt(report),
    resume: true,
  });
}
