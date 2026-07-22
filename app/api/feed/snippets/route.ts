import { desc, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedProposals, feedSnippets } from "@/db/schema";
import { feedWorkingDir, runFeedAgent } from "@/app/lib/feed-agent";
import { buildSnippetPrompt } from "@/app/lib/feed-prompt";
import { collectSnippetAttachments, type SnippetAttachment } from "@/app/lib/feed-attachments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Validate a queued-workflow-steps JSON string down to [{label, prompt}]; the
 *  agent never sees this directly, so it just needs to be well-formed. Returns
 *  null (store nothing) when there are no valid remaining steps. */
function normalizeWorkflowSteps(raw: string): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const steps = parsed
      .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === "object")
      .map((step) => ({
        label: typeof step.label === "string" ? step.label.slice(0, 60) : "",
        prompt: typeof step.prompt === "string" ? step.prompt.trim().slice(0, 4000) : "",
      }))
      .filter((step) => step.prompt);
    return steps.length ? JSON.stringify(steps) : null;
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  const database = await ensureDatabase();
  const rows = database
    .select()
    .from(feedSnippets)
    .orderBy(desc(feedSnippets.updatedAt))
    .all();
  // Count pending proposals per snippet so the list can badge feeds awaiting
  // approval (the detail view has this, but the sidebar row didn't show it).
  const pendingRows = database
    .select({ snippetId: feedProposals.snippetId, count: sql<number>`count(*)` })
    .from(feedProposals)
    .where(eq(feedProposals.status, "pending"))
    .groupBy(feedProposals.snippetId)
    .all();
  const pendingBySnippet = new Map(pendingRows.map((row) => [row.snippetId, Number(row.count)]));
  const snippets = rows.map((row) => ({ ...row, pendingProposals: pendingBySnippet.get(row.id) ?? 0 }));
  return Response.json({ snippets });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const id = `feed-${crypto.randomUUID()}`;
    const sessionId = crypto.randomUUID();
    const workingDir = feedWorkingDir(id);

    // The composer sends multipart/form-data when files are attached and JSON
    // otherwise. Either way we end up with an instruction, optional captured
    // text, attached library paper ids, and uploaded files staged on disk.
    let instruction = "";
    let freeText = "";
    let title = "";
    let paperIds: string[] = [];
    let attachments: SnippetAttachment[] = [];
    // Remaining workflow steps queued after this opening turn (JSON string), when
    // the feed was started from a multi-step workflow.
    let workflowSteps = "";

    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      instruction = String(form.get("instruction") ?? "").trim();
      freeText = String(form.get("body") ?? "").trim();
      title = String(form.get("title") ?? "").trim();
      paperIds = form.getAll("paperIds").map((value) => String(value)).filter(Boolean);
      workflowSteps = String(form.get("workflowSteps") ?? "").trim();
      const files = form.getAll("files").filter((value): value is File => value instanceof File);
      attachments = await collectSnippetAttachments(workingDir, files, paperIds);
    } else {
      const body = (await request.json()) as {
        instruction?: string; body?: string; title?: string; paperIds?: string[]; workflowSteps?: unknown;
      };
      instruction = body.instruction?.trim() ?? "";
      freeText = body.body?.trim() ?? "";
      title = body.title?.trim() ?? "";
      paperIds = Array.isArray(body.paperIds) ? body.paperIds.filter(Boolean) : [];
      workflowSteps = Array.isArray(body.workflowSteps) ? JSON.stringify(body.workflowSteps) : "";
      attachments = await collectSnippetAttachments(workingDir, [], paperIds);
    }

    if (!instruction && !freeText && !attachments.length) {
      return Response.json({ error: "Enter an instruction, some text, or an attachment for the agent." }, { status: 400 });
    }

    const database = await ensureDatabase();
    const now = new Date().toISOString();
    const resolvedTitle = (title || instruction || freeText || attachments[0]?.label || "Untitled").slice(0, 120);
    database
      .insert(feedSnippets)
      .values({
        id,
        title: resolvedTitle,
        instruction: instruction || freeText,
        status: "queued",
        sessionId: "",
        attachments: attachments.length ? JSON.stringify(attachments) : null,
        workflowSteps: normalizeWorkflowSteps(workflowSteps),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const prompt = buildSnippetPrompt({ instruction, freeText, attachments });
    // Fire-and-forget: the agent streams events into feed_messages and SSE.
    void runFeedAgent({ snippetId: id, sessionId, prompt, resume: false }).catch(() => {});

    return Response.json({ id });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The snippet could not be created." },
      { status: 400 },
    );
  }
}
