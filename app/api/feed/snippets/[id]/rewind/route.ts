import { asc, eq, inArray } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";
import { isFeedRunning, stopFeedAndWait } from "@/app/lib/feed-agent";
import { groupFeedInteractions, messagesFromInteraction } from "@/app/lib/feed-history";
import { parseWith } from "@/app/lib/schemas/parse";
import { FeedRewindRequestSchema } from "@/app/lib/schemas/requests";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Rewind a thread to one of its interactions, in place.
 *
 * The interaction and every later one are removed, and the user turn that started
 * it comes back so the composer can offer it for editing: the point of a rewind is
 * to take a turn back and ask differently. Forking the same point copies that
 * history into a new feed instead and leaves this one alone; both work from the
 * interaction boundaries in app/lib/feed-history.ts, so "where a turn begins and
 * ends" is decided in one place for the selection UI, the fork, and this.
 *
 * A running turn is stopped first, since it is producing the very messages this is
 * about to delete.
 *
 * The agent's session is cleared rather than resumed. The Claude CLI session still
 * holds the full conversation, so resuming it would leave the agent acting on turns
 * the thread no longer shows. An empty session id is what a forked thread carries,
 * and the next reply already knows how to seed a fresh session from the messages
 * that remain.
 *
 * Library changes the user already approved are NOT reverted: they are the user's
 * own decisions, applied to their library, and a conversation rewind does not
 * revoke them. Proposals belonging to the removed interactions are dropped, so a
 * pending one cannot be approved after the message that proposed it is gone.
 *
 * A feed mirrored to a GitHub issue is unlinked, because the removed messages are
 * still comments on that issue: keeping the link would let the next sync read a
 * rewound comment back in as new and start a turn on it. The next sync opens a
 * fresh issue and mirrors what the thread now holds.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const parsed = parseWith(FeedRewindRequestSchema, await request.json().catch(() => ({})));
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const database = await ensureDatabase();
  const snippet = database.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();
  if (!snippet) {
    return Response.json({ error: "Snippet not found." }, { status: 404 });
  }

  const interactions = () => groupFeedInteractions(
    snippet.instruction,
    snippet.attachments,
    database
      .select()
      .from(feedMessages)
      .where(eq(feedMessages.snippetId, id))
      .orderBy(asc(feedMessages.createdAt))
      .all(),
  );
  const target = interactions().find((interaction) => interaction.id === parsed.data.interactionId);
  if (!target) {
    return Response.json({ error: "That interaction is not part of this feed." }, { status: 404 });
  }

  if (isFeedRunning(id)) {
    await stopFeedAndWait(id);
  }

  // Regrouped after the stop: a turn that was still running may have written more
  // messages between the read above and its exit, and those belong to the cut.
  const removed = messagesFromInteraction(interactions(), parsed.data.interactionId);
  const removedIds = removed.map((message) => message.id);
  // Only a message that concluded a turn carries usage, so the rows with usage are
  // the turns being removed: subtract exactly those from the feed's totals instead
  // of leaving the header counting work that is no longer in the thread.
  const spent = removed.reduce(
    (totals, message) => ({
      inputTokens: totals.inputTokens + message.inputTokens,
      outputTokens: totals.outputTokens + message.outputTokens,
      durationMs: totals.durationMs + message.durationMs,
      turns: totals.turns + (message.inputTokens || message.outputTokens || message.durationMs ? 1 : 0),
    }),
    { inputTokens: 0, outputTokens: 0, durationMs: 0, turns: 0 },
  );
  const now = new Date().toISOString();

  database.transaction((tx) => {
    tx.delete(feedMessages).where(inArray(feedMessages.id, removedIds)).run();
    // Both halves matter: a proposal anchored to a removed message, and one the
    // removed turns created without an anchor Stacks kept (an API-posted proposal
    // records the tool_use message it came with, which is itself removed here).
    for (const proposal of database.select().from(feedProposals).where(eq(feedProposals.snippetId, id)).all()) {
      const orphaned = proposal.messageId ? removedIds.includes(proposal.messageId) : false;
      if (orphaned || (removed.length > 0 && proposal.createdAt >= removed[0].createdAt)) {
        tx.delete(feedProposals).where(eq(feedProposals.id, proposal.id)).run();
      }
    }
    if (snippet.issueNumber !== null) {
      // Everything that stays has to be mirrored again into the replacement issue,
      // so drop the comment ids pointing into the old one.
      tx.update(feedMessages)
        .set({ githubCommentId: null, attachmentsSynced: 0 })
        .where(eq(feedMessages.snippetId, id))
        .run();
      tx.update(feedProposals)
        .set({ githubCommentId: null, githubStatusSynced: null })
        .where(eq(feedProposals.snippetId, id))
        .run();
      tx.insert(feedMessages).values({
        id: `msg-${crypto.randomUUID()}`,
        snippetId: id,
        role: "system",
        kind: "text",
        content: `Rewound past messages already mirrored to GitHub issue #${snippet.issueNumber}; the next sync opens a fresh issue for this thread.`,
        createdAt: now,
      }).run();
    }
    tx.update(feedSnippets)
      .set({
        sessionId: "",
        status: "done",
        ...(snippet.issueNumber === null
          ? {}
          : { issueNumber: null, issueTitleSynced: null, issueStateSynced: null }),
        inputTokens: Math.max(0, snippet.inputTokens - spent.inputTokens),
        outputTokens: Math.max(0, snippet.outputTokens - spent.outputTokens),
        durationMs: Math.max(0, snippet.durationMs - spent.durationMs),
        turns: Math.max(0, snippet.turns - spent.turns),
        updatedAt: now,
      })
      .where(eq(feedSnippets.id, id))
      .run();
  });

  // The opening interaction's user turn is the feed's own instruction, which stays:
  // rewinding there clears the replies and leaves the question standing.
  return Response.json({ removed: removedIds.length, reply: target.opening ? "" : target.userText });
}
