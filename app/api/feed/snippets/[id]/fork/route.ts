import { asc, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Fork a feed into an independent branch: copy the snippet, its messages, and
 * its proposals into a new thread with a fresh session id. The parent is left
 * untouched. Replying to the fork starts a new agent session; the copied
 * transcript is shown as the branch's history, so the user can take the
 * conversation in a new direction without disturbing the original.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const database = await ensureDatabase();
  const source = database.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();
  if (!source) {
    return Response.json({ error: "Snippet not found." }, { status: 404 });
  }

  const forkId = `feed-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const messages = database
    .select()
    .from(feedMessages)
    .where(eq(feedMessages.snippetId, id))
    .orderBy(asc(feedMessages.createdAt))
    .all();
  const proposals = database.select().from(feedProposals).where(eq(feedProposals.snippetId, id)).all();

  database.transaction((tx) => {
    tx.insert(feedSnippets).values({
      id: forkId,
      title: `Fork of ${source.title || source.instruction || "Untitled"}`.slice(0, 200),
      instruction: source.instruction,
      // A fresh session: the fork continues as a new agent conversation seeded
      // with the copied history, rather than mutating the parent's session.
      status: source.status === "running" || source.status === "queued" ? "done" : source.status,
      sessionId: "",
      inputTokens: source.inputTokens,
      outputTokens: source.outputTokens,
      durationMs: source.durationMs,
      turns: source.turns,
      createdAt: now,
      updatedAt: now,
    }).run();
    for (const message of messages) {
      tx.insert(feedMessages).values({
        id: `msg-${crypto.randomUUID()}`,
        snippetId: forkId,
        role: message.role,
        kind: message.kind,
        content: message.content,
        toolUseId: message.toolUseId,
        createdAt: message.createdAt,
      }).run();
    }
    for (const proposal of proposals) {
      tx.insert(feedProposals).values({
        id: `prop-${crypto.randomUUID()}`,
        snippetId: forkId,
        messageId: null,
        operation: proposal.operation,
        // Applied/rejected decisions carry over as history; pending resets so the
        // fork does not re-apply changes the user is still deciding on.
        status: proposal.status === "pending" ? "pending" : proposal.status,
        createdAt: proposal.createdAt,
      }).run();
    }
  });

  return Response.json({ id: forkId });
}
