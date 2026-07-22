import { asc, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";
import { feedWorkingDir, isFeedRunning, runFeedAgent, stopFeedAndWait } from "@/app/lib/feed-agent";
import { buildFollowUpPrompt, buildForkPrompt } from "@/app/lib/feed-prompt";
import { collectSnippetAttachments, type SnippetAttachment } from "@/app/lib/feed-attachments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function proposalSummary(operation: string): string {
  try {
    return (JSON.parse(operation) as { summary?: string }).summary ?? "a change";
  } catch {
    return "a change";
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  // The reply box sends multipart when files/papers are attached, JSON otherwise.
  let reply = "";
  let files: File[] = [];
  let paperIds: string[] = [];
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    reply = String(form.get("reply") ?? "").trim();
    paperIds = form.getAll("paperIds").map((value) => String(value)).filter(Boolean);
    files = form.getAll("files").filter((value): value is File => value instanceof File);
  } else {
    const body = (await request.json().catch(() => ({}))) as { reply?: string };
    reply = body.reply?.trim() ?? "";
  }

  const database = await ensureDatabase();
  const snippet = database.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();
  if (!snippet) {
    return Response.json({ error: "Snippet not found." }, { status: 404 });
  }
  // Interrupt-then-send: if the agent is mid-run, stop it and wait for the
  // process to fully exit before starting the new turn, so two `claude -p
  // --resume` processes never write the same session transcript at once.
  if (isFeedRunning(id)) {
    await stopFeedAndWait(id);
  }

  let attachments: SnippetAttachment[] = [];
  if (files.length || paperIds.length) {
    attachments = await collectSnippetAttachments(feedWorkingDir(id), files, paperIds);
  }
  if (!reply && !attachments.length) {
    return Response.json({ error: "Enter a follow-up message or attach a file." }, { status: 400 });
  }

  // Report the outcomes of proposals the user resolved since the last turn so
  // the agent knows what was applied or rejected, then continue the thread.
  const proposals = database.select().from(feedProposals).where(eq(feedProposals.snippetId, id)).all();
  const appliedSummaries = proposals.filter((p) => p.status === "applied").map((p) => proposalSummary(p.operation));
  const rejectedSummaries = proposals.filter((p) => p.status === "rejected").map((p) => proposalSummary(p.operation));

  const displayReply = reply || `(attached ${attachments.length} file${attachments.length === 1 ? "" : "s"})`;
  database
    .insert(feedMessages)
    .values({ id: `msg-${crypto.randomUUID()}`, snippetId: id, role: "user", kind: "text", content: displayReply, attachments: attachments.length ? JSON.stringify(attachments) : null, createdAt: new Date().toISOString() })
    .run();

  if (snippet.sessionId) {
    // Existing session: resume it with the follow-up.
    const prompt = buildFollowUpPrompt({ reply, appliedSummaries, rejectedSummaries, attachments });
    void runFeedAgent({ snippetId: id, sessionId: snippet.sessionId, prompt, resume: true }).catch(() => {});
  } else {
    // No session yet (a forked thread): start a fresh session seeded with the
    // copied conversation as a transcript so the branch keeps its context.
    const history = database
      .select()
      .from(feedMessages)
      .where(eq(feedMessages.snippetId, id))
      .orderBy(asc(feedMessages.createdAt))
      .all()
      .filter((message) => message.kind === "text" || message.kind === "result")
      .map((message) => `${message.role === "user" ? "User" : "Agent"}: ${message.content}`)
      .join("\n\n");
    const prompt = buildForkPrompt({ reply, transcript: history, attachments });
    void runFeedAgent({ snippetId: id, sessionId: crypto.randomUUID(), prompt, resume: false }).catch(() => {});
  }

  return Response.json({ ok: true });
}
