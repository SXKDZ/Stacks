import { asc, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedSnippets } from "@/db/schema";
import { feedWorkingDir, isFeedRunning, runFeedAgent, stopFeedAndWait } from "@/app/lib/feed-agent";
import { buildFollowUpPrompt, buildForkPrompt } from "@/app/lib/feed-prompt";
import { collectSnippetAttachments, type SnippetAttachment } from "@/app/lib/feed-attachments";
import { markOutcomesReported, unreportedOutcomes } from "@/app/lib/feed-outcomes";
import { parseWith } from "@/app/lib/schemas/parse";
import { effortSetting } from "@/app/lib/effort";
import { FeedReplyRequestSchema } from "@/app/lib/schemas/requests";
import { buildFeedTranscript } from "@/app/lib/feed-history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  // The reply box sends multipart when files/papers are attached, JSON otherwise.
  let reply = "";
  let model: string | null = null;
  let effort: string | null = null;
  let files: File[] = [];
  let paperIds: string[] = [];
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    reply = String(form.get("reply") ?? "").trim();
    if (form.has("model")) model = String(form.get("model") ?? "").trim();
    if (form.has("effort")) effort = String(form.get("effort") ?? "").trim();
    paperIds = form.getAll("paperIds").map((value) => String(value)).filter(Boolean);
    files = form.getAll("files").filter((value): value is File => value instanceof File);
  } else {
    const parsed = parseWith(FeedReplyRequestSchema, await request.json().catch(() => ({})));
    const body = parsed.ok ? parsed.data : {};
    reply = body.reply?.trim() ?? "";
    if (typeof body.model === "string") model = body.model.trim();
    if (typeof body.effort === "string") effort = body.effort.trim();
  }

  const database = await ensureDatabase();
  const snippet = database.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();
  if (!snippet) {
    return Response.json({ error: "Snippet not found." }, { status: 404 });
  }
  let attachments: SnippetAttachment[] = [];
  if (files.length || paperIds.length) {
    attachments = await collectSnippetAttachments(feedWorkingDir(id), files, paperIds);
  }
  if (!reply && !attachments.length) {
    return Response.json({ error: "Enter a follow-up message or attach a file." }, { status: 400 });
  }

  // Interrupt-then-send: if the agent is mid-run, stop it and wait for the
  // process to fully exit before starting the new turn, so two `claude -p
  // --resume` processes never write the same session transcript at once.
  // The interrupted turn never answered what it was asked, so the new turn is
  // told to cover that request too and the thread records the gap.
  const interrupted = isFeedRunning(id);
  if (interrupted) {
    await stopFeedAndWait(id);
    database
      .insert(feedMessages)
      .values({
        id: `msg-${crypto.randomUUID()}`,
        snippetId: id,
        role: "system",
        kind: "text",
        content: "Stopped this turn to send the next message; its request carries into the next turn.",
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  // The reply can switch the feed's model; the change persists so every later
  // turn (including retries and GitHub-sync turns) uses it, and it is recorded
  // in the thread (and thus mirrored to the GitHub issue by the next sync).
  if (model !== null && model !== (snippet.model ?? "")) {
    database
      .update(feedSnippets)
      .set({ model: model.slice(0, 200) || null })
      .where(eq(feedSnippets.id, id))
      .run();
    database
      .insert(feedMessages)
      .values({
        id: `msg-${crypto.randomUUID()}`,
        snippetId: id,
        role: "system",
        kind: "text",
        content: model ? `Switched to model ${model}.` : "Switched back to the default model.",
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  // The reply can also change this feed's reasoning effort, and like the model it
  // persists for every later turn.
  if (effort !== null) {
    const next = effortSetting(effort);
    if (next !== effortSetting(snippet.effort)) {
      database.update(feedSnippets).set({ effort: next || null }).where(eq(feedSnippets.id, id)).run();
      database
        .insert(feedMessages)
        .values({
          id: `msg-${crypto.randomUUID()}`,
          snippetId: id,
          role: "system",
          kind: "text",
          content: next ? `Switched to ${next} reasoning effort.` : "Switched back to the default reasoning effort.",
          createdAt: new Date().toISOString(),
        })
        .run();
    }
  }

  // Carry the decisions the agent has not been told about yet, and only those:
  // reporting every applied/rejected proposal in the thread repeated the same
  // list on every turn. Marked as reported here so the follow-up turn owns them.
  const outcomes = await unreportedOutcomes(id);
  await markOutcomesReported(outcomes.ids);

  // A fork has no native Claude session. Capture its copied history BEFORE the
  // current reply is inserted, otherwise the fresh-session prompt includes the
  // same user turn once in the transcript and again as the continuation.
  const forkTranscript = snippet.sessionId
    ? ""
    : buildFeedTranscript(
        snippet.instruction,
        database
          .select()
          .from(feedMessages)
          .where(eq(feedMessages.snippetId, id))
          .orderBy(asc(feedMessages.createdAt))
          .all(),
        snippet.historyMode === "tools",
      );

  const displayReply = reply || `(attached ${attachments.length} file${attachments.length === 1 ? "" : "s"})`;
  database
    .insert(feedMessages)
    .values({ id: `msg-${crypto.randomUUID()}`, snippetId: id, role: "user", kind: "text", content: displayReply, attachments: attachments.length ? JSON.stringify(attachments) : null, createdAt: new Date().toISOString() })
    .run();

  if (snippet.sessionId) {
    // Existing session: resume it with the follow-up.
    const prompt = buildFollowUpPrompt({ reply, outcomes, attachments, interrupted });
    void runFeedAgent({ snippetId: id, sessionId: snippet.sessionId, prompt, resume: true }).catch(() => {});
  } else {
    // No session yet (a forked thread): start a fresh session seeded with the
    // copied conversation as a transcript so the branch keeps its context.
    const prompt = buildForkPrompt({ reply, transcript: forkTranscript, attachments, interrupted });
    void runFeedAgent({ snippetId: id, sessionId: crypto.randomUUID(), prompt, resume: false }).catch(() => {});
  }

  return Response.json({ ok: true });
}
