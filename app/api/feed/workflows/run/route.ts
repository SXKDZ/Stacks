import { ensureDatabase } from "@/db/bootstrap";
import { feedSnippets } from "@/db/schema";
import { feedWorkingDir } from "@/app/lib/feed-agent";
import { readWorkflowMeta, runWorkflow } from "@/app/lib/workflow-runtime";
import { parseWith } from "@/app/lib/schemas/parse";
import { FeedWorkflowRunRequestSchema } from "@/app/lib/schemas/requests";
import { mkdirSync } from "node:fs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Start a Claude Code workflow. Creates a feed thread for the run and executes
 * the script in the background — its agents stream into the thread and any
 * library writes queue as approval-gated proposals, exactly like a normal feed.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = parseWith(FeedWorkflowRunRequestSchema, await request.json().catch(() => ({})));
    const body = parsed.ok ? parsed.data : {};
    const script = body.script ?? "";
    if (!script.trim()) {
      return Response.json({ error: "Provide a workflow script to run." }, { status: 400 });
    }
    const meta = readWorkflowMeta(script);
    if (!meta) {
      return Response.json({ error: "The script has no valid `export const meta = { name, description }` block." }, { status: 400 });
    }

    const id = `feed-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    mkdirSync(feedWorkingDir(id), { recursive: true });

    const database = await ensureDatabase();
    database.insert(feedSnippets).values({
      id,
      title: `Workflow: ${meta.name}`.slice(0, 120),
      // Capped like the save route caps it: the description comes from the
      // script's own meta, so a script could otherwise write a megabyte straight
      // into the feed row it creates.
      instruction: meta.description.slice(0, 2000),
      status: "queued",
      sessionId: "",
      createdAt: now,
      updatedAt: now,
    }).run();

    // Fire-and-forget: the run streams into the thread and settles the status.
    void runWorkflow({ snippetId: id, script, args: body.args }).catch(() => {});

    return Response.json({ id });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The workflow could not be started." },
      { status: 400 },
    );
  }
}
