import { ensureDatabase } from "@/db/bootstrap";
import { feedSnippets } from "@/db/schema";
import { feedWorkingDir, runFeedAgent } from "@/app/lib/feed-agent";
import { buildSnippetPrompt } from "@/app/lib/feed-prompt";
import { readFeedWorkflows } from "@/app/lib/local-settings";
import { DEFAULT_FEED_WORKFLOWS, normalizeFeedWorkflows, type FeedWorkflow } from "@/app/lib/feed-workflows";

/**
 * Scheduled/recurring feed workflows. A workflow with intervalMinutes > 0 is
 * auto-started by the always-on server on that cadence. This is safe under the
 * feed's security model: a scheduled run only queues proposals — every DB write
 * still needs the user's explicit approval, so nothing mutates unattended.
 */

// Per-workflow last-run wall-clock (ms). In-memory only: on a server restart the
// first tick reschedules everything, which just means an extra run at most.
const lastRunAt = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Start a feed from a workflow: step 1 runs now, the rest queue for approval. */
export async function startWorkflowRun(workflow: FeedWorkflow, trigger: "scheduled" | "manual"): Promise<string> {
  const [first, ...rest] = workflow.steps;
  if (!first) throw new Error("Workflow has no steps.");
  const id = `feed-${crypto.randomUUID()}`;
  const sessionId = crypto.randomUUID();
  const workingDir = feedWorkingDir(id);
  const database = await ensureDatabase();
  const now = new Date().toISOString();
  database
    .insert(feedSnippets)
    .values({
      id,
      title: `${workflow.label}${trigger === "scheduled" ? " (scheduled)" : ""}`.slice(0, 120),
      instruction: first.prompt,
      status: "queued",
      sessionId: "",
      workflowSteps: rest.length ? JSON.stringify(rest) : null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const prompt = buildSnippetPrompt({ instruction: first.prompt, freeText: "", attachments: [] });
  void runFeedAgent({ snippetId: id, sessionId, prompt, resume: false }).catch(() => {});
  return id;
}

/** Check every scheduled workflow and start any that are due. */
async function tick(): Promise<void> {
  const saved = readFeedWorkflows();
  const workflows = saved === undefined ? DEFAULT_FEED_WORKFLOWS : normalizeFeedWorkflows(saved);
  const now = Date.now();
  for (const workflow of workflows) {
    const interval = workflow.intervalMinutes ?? 0;
    if (interval <= 0) continue;
    const last = lastRunAt.get(workflow.id) ?? 0;
    if (now - last < interval * 60_000) continue;
    lastRunAt.set(workflow.id, now);
    try {
      await startWorkflowRun(workflow, "scheduled");
    } catch {
      // A failed scheduled launch must not stop the loop or crash the server.
    }
  }
}

/** Start the once-per-process poll loop (idempotent). Called from instrumentation. */
export function startFeedScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), 60_000);
  // Don't keep the process alive solely for the scheduler.
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}
