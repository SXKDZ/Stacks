import { eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedSnippets } from "@/db/schema";
import { isFeedRunning, isFeedUninterruptible, stopFeedAndWait } from "@/app/lib/feed-agent";
import { feedInteractions, truncateFeedAt } from "@/app/lib/feed-truncate";
import { isGithubSyncRunning } from "@/app/lib/feed-sync-state";
import { parseWith } from "@/app/lib/schemas/parse";
import { FeedInteractionCutSchema } from "@/app/lib/schemas/requests";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Rewind a thread to one of its interactions, in place.
 *
 * The interaction and every later one are removed, and the user turn that started it
 * comes back so the composer can offer it for editing: the point of a rewind is to
 * take a turn back and ask differently. Retrying the same point keeps that turn and
 * re-runs it; forking it copies the history into a new feed and leaves this one
 * alone. All three cut at the boundaries in app/lib/feed-history.ts.
 *
 * A running turn is stopped first, since it is producing the very messages this is
 * about to delete.
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
  // A sync pass in flight may be ingesting a comment from the phone into this very
  // thread. Cutting now would delete that message before anyone saw it arrive.
  if (isGithubSyncRunning()) {
    return Response.json({ error: "A GitHub sync is running. Try again when it finishes." }, { status: 409 });
  }
  if (isFeedRunning(id)) {
    await stopFeedAndWait(id);
  }

  const truncation = await truncateFeedAt(snippet, parsed.data.interactionId, { keepStarter: false });
  if (!truncation) {
    return Response.json({ error: "That interaction is not part of this feed." }, { status: 404 });
  }

  // The opening interaction's user turn is the feed's own instruction, which stays:
  // rewinding there clears the replies and leaves the question standing.
  return Response.json({
    removed: truncation.removed.length,
    reply: truncation.target.opening ? "" : truncation.target.userText,
  });
}
