import { ensureDatabase } from "@/db/bootstrap";
import { feedSnippets } from "@/db/schema";
import { feedWorkingDir } from "@/app/lib/feed-agent";
import { readWorkflowMeta, runWorkflow } from "@/app/lib/workflow-runtime";
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
    const body = (await request.json().catch(() => ({}))) as { script?: string; args?: unknown };
    const script = typeof body.script === "string" ? body.script : "";
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
      instruction: meta.description,
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
