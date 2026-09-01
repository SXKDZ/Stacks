import { eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedSnippets } from "@/db/schema";
import { isFeedRunning, isFeedUninterruptible, runFeedAgent, stopFeedAndWait } from "@/app/lib/feed-agent";
import { buildFeedTranscript } from "@/app/lib/feed-history";
import { buildForkPrompt, buildSnippetPrompt } from "@/app/lib/feed-prompt";
import { feedInteractions, truncateFeedAt } from "@/app/lib/feed-truncate";
import { parseJsonWith, parseWith } from "@/app/lib/schemas/parse";
import { SnippetAttachmentListSchema } from "@/app/lib/schemas/attachments";
import { FeedInteractionCutSchema } from "@/app/lib/schemas/requests";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Ask one of the thread's turns again.
 *
 * The turn's own message stays; what it produced (its tool traffic, its reply, and
 * every later turn) is removed and the request runs again. That is the difference
 * from a rewind, which also takes the message back and hands it to the composer: a
 * retry is for a turn that was interrupted or failed, where the question was right
 * and only the answer is missing.
 *
 * The turn runs in a fresh Claude session seeded with the history before it, because
 * the previous session's transcript still holds the attempt being replaced. Files and
 * papers attached to that turn are already staged in the feed's working directory, so
 * they are described to the agent again without being re-uploaded.
 *
 * Approval decisions the agent has not been told about are deliberately not carried
 * here: they stay unreported and reach it with the next reply, rather than being
 * mixed into a turn whose job is to answer the question again.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const parsed = parseWith(FeedInteractionCutSchema, await request.json().catch(() => ({})));
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const database = await ensureDatabase();
  const snippet = database.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();
  if (!snippet) {
    return Response.json({ error: "Snippet not found." }, { status: 404 });
  }
  // Checked before the stop, so an unknown id cannot cost a running turn its work.
  const interactions = await feedInteractions(snippet);
  if (!interactions.some((interaction) => interaction.id === parsed.data.interactionId)) {
    return Response.json({ error: "That interaction is not part of this feed." }, { status: 404 });
  }

  // A compaction holds the run slot with no process to interrupt, so stopping would
  // return at once and this would delete the messages it is reading.
  if (isFeedUninterruptible(id)) {
    return Response.json({ error: "This thread is being compacted. Try again when that finishes." }, { status: 409 });
  }
  if (isFeedRunning(id)) {
    await stopFeedAndWait(id);
  }

  const truncation = await truncateFeedAt(snippet, parsed.data.interactionId, { keepStarter: true });
  if (!truncation) {
    return Response.json({ error: "That interaction is not part of this feed." }, { status: 404 });
  }

  const { target, kept } = truncation;
  if (target.opening) {
    // The opening turn is the feed's instruction, so this is the prompt the feed
    // started from: the same builder the composer's first run uses.
    const prompt = buildSnippetPrompt({
      instruction: snippet.instruction,
      freeText: "",
      attachments: attachmentList(snippet.attachments),
    });
    void runFeedAgent({ snippetId: id, sessionId: crypto.randomUUID(), prompt, resume: false }).catch(() => {});
    return Response.json({ removed: truncation.removed.length, retried: snippet.instruction });
  }

  const starter = target.messages[0];
  // The turn being retried is the prompt, so it is excluded from the history the
  // fresh session is seeded with; otherwise the agent reads the same request twice.
  const transcript = buildFeedTranscript(
    snippet.instruction,
    kept.filter((message) => message.id !== starter.id),
    snippet.historyMode === "tools",
  );
  const prompt = buildForkPrompt({
    reply: starter.content,
    transcript,
    attachments: attachmentList(starter.attachments),
  });
  void runFeedAgent({ snippetId: id, sessionId: crypto.randomUUID(), prompt, resume: false }).catch(() => {});
  return Response.json({ removed: truncation.removed.length, retried: starter.content });
}

/** The turn's staged attachments, or none if the row cannot be read. */
function attachmentList(raw: string | null) {
  if (!raw) return [];
  const parsed = parseJsonWith(SnippetAttachmentListSchema, raw);
  return parsed.ok ? parsed.data : [];
}
