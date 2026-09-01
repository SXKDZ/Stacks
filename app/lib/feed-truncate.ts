/**
 * Cutting a feed thread short, in place.
 *
 * Two features do this: a rewind takes the thread back to before one of the user's
 * turns, and a retry re-runs that turn after removing what it produced. They differ
 * only in whether the turn's own message survives, so the deletion, the proposal
 * cleanup, the usage arithmetic, and the GitHub unlink live here once. Where a turn
 * begins and ends comes from app/lib/feed-history.ts, the same boundaries the
 * history-selection UI and a fork use.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";
import { groupFeedInteractions, messagesFromInteraction, type FeedInteraction } from "@/app/lib/feed-history";
import { enqueueEditComment, flushGithubOutbox, retireComments } from "@/app/lib/feed-github-outbox";

type FeedSnippetRow = typeof feedSnippets.$inferSelect;
export type FeedMessageRow = typeof feedMessages.$inferSelect;

export interface FeedTruncation {
  /** The interaction the cut was made at. */
  target: FeedInteraction<FeedMessageRow>;
  /** Messages that were deleted. */
  removed: FeedMessageRow[];
  /** Messages still in the thread, oldest first. */
  kept: FeedMessageRow[];
}

/** This feed's interactions, grouped from its stored thread. */
export async function feedInteractions(
  snippet: Pick<FeedSnippetRow, "id" | "instruction" | "attachments">,
): Promise<FeedInteraction<FeedMessageRow>[]> {
  const database = await ensureDatabase();
  return groupFeedInteractions(
    snippet.instruction,
    snippet.attachments,
    database
      .select()
      .from(feedMessages)
      .where(eq(feedMessages.snippetId, snippet.id))
      .orderBy(asc(feedMessages.createdAt))
      .all(),
  );
}

/**
 * Remove an interaction and every later one. With `keepStarter` the user turn that
 * began it stays, which is what a retry re-runs.
 *
 * Returns null when the id is not an interaction boundary. Call it after any running
 * turn has exited: it regroups the thread itself, so messages that turn wrote on its
 * way out are part of the cut.
 *
 * Library changes the user already approved are NOT reverted. They are the user's
 * own decisions, applied to their library, and cutting the conversation short does
 * not revoke them. The proposals themselves go, so a pending one cannot be approved
 * after the message that proposed it is gone.
 *
 * A mirrored feed keeps its GitHub issue. The comments belonging to removed messages
 * are retired rather than unlinked or deleted: the issue stays a record of what
 * happened, the surviving comments stay in step, and nothing is mirrored a second
 * time. Unlinking instead left an issue no feed claimed, which the next inbound pass
 * adopted as a feed of its own.
 */
export async function truncateFeedAt(
  snippet: FeedSnippetRow,
  interactionId: string,
  options: { keepStarter: boolean },
): Promise<FeedTruncation | null> {
  const database = await ensureDatabase();
  const interactions = await feedInteractions(snippet);
  const target = interactions.find((interaction) => interaction.id === interactionId);
  if (!target) return null;

  const starter = target.opening ? null : target.messages[0] ?? null;
  const cut = messagesFromInteraction(interactions, interactionId);
  const removed = options.keepStarter && starter
    ? cut.filter((message) => message.id !== starter.id)
    : cut;
  const removedIds = new Set(removed.map((message) => message.id));
  const kept = interactions
    .flatMap((interaction) => interaction.messages)
    .filter((message) => !removedIds.has(message.id));

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

  // Both halves matter: a proposal anchored to a removed message, and one the removed
  // turns created without an anchor Stacks kept (an API-posted proposal records the
  // tool_use message it came with, which is itself removed here).
  const firstRemoved = cut[0]?.createdAt;
  const droppedProposals = database
    .select()
    .from(feedProposals)
    .where(eq(feedProposals.snippetId, snippet.id))
    .all()
    .filter((proposal) => (proposal.messageId ? removedIds.has(proposal.messageId) : false)
      || (firstRemoved !== undefined && proposal.createdAt >= firstRemoved));
  // Comments the removed messages were mirrored to. The remote comments stay: one the
  // user wrote from their phone is theirs, and one Stacks posted is a record of what
  // happened. They are retired instead, so the inbound pass never reads them as new.
  const retiredComments = removed
    .map((message) => message.githubCommentId)
    .filter((commentId): commentId is number => typeof commentId === "number");

  database.transaction((tx) => {
    if (removedIds.size) {
      tx.delete(feedMessages).where(inArray(feedMessages.id, [...removedIds])).run();
    }
    for (const proposal of droppedProposals) {
      tx.delete(feedProposals).where(eq(feedProposals.id, proposal.id)).run();
    }
    if (snippet.issueNumber !== null && retiredComments.length) {
      // The issue keeps its link and every surviving comment id, so nothing is
      // mirrored twice. This note is what explains the gap to a phone reader.
      tx.insert(feedMessages).values({
        id: `msg-${crypto.randomUUID()}`,
        snippetId: snippet.id,
        role: "system",
        kind: "text",
        content: `Removed ${retiredComments.length} message${retiredComments.length === 1 ? "" : "s"} that had been mirrored to GitHub issue #${snippet.issueNumber}. Their comments stay on the issue as a record, but are no longer read.`,
        createdAt: now,
      }).run();
    }
    // The agent's session is dropped rather than resumed: the Claude CLI session
    // still holds the full conversation, so resuming it would leave the agent acting
    // on turns the thread no longer shows. An empty session id is what a forked
    // thread carries, and the caller seeds a fresh one from what remains.
    tx.update(feedSnippets)
      .set({
        sessionId: "",
        status: "done",
        inputTokens: Math.max(0, snippet.inputTokens - spent.inputTokens),
        outputTokens: Math.max(0, snippet.outputTokens - spent.outputTokens),
        durationMs: Math.max(0, snippet.durationMs - spent.durationMs),
        turns: Math.max(0, snippet.turns - spent.turns),
        updatedAt: now,
      })
      .where(eq(feedSnippets.id, snippet.id))
      .run();
  });

  if (snippet.issueNumber !== null) {
    await retireComments(snippet.id, retiredComments);
    // A proposal's mirrored comment offers it for approval. Cut from the thread, it
    // cannot be approved any more, so the comment has to stop saying it is pending.
    for (const proposal of droppedProposals) {
      if (typeof proposal.githubCommentId === "number") {
        await enqueueEditComment(
          snippet.issueNumber,
          proposal.githubCommentId,
          `**Proposed library change** · 🗑 Removed from the thread\n\n_This change was withdrawn when the thread was rewound; there is nothing to approve._`,
        );
      }
    }
    void flushGithubOutbox().catch(() => {});
  }

  return { target, removed, kept };
}
