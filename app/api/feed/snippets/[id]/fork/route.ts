import { asc, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";
import { copyFeedHistoryAttachments } from "@/app/lib/feed-history-attachments";
import { feedWorkingDir } from "@/app/lib/feed-agent";
import { selectFeedHistory } from "@/app/lib/feed-history";
import { parseWith } from "@/app/lib/schemas/parse";
import { FeedForkRequestSchema } from "@/app/lib/schemas/requests";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function serializedAttachments(attachments: ReturnType<typeof copyFeedHistoryAttachments>): string | null {
  return attachments.length ? JSON.stringify(attachments) : null;
}

/**
 * Fork a feed into an independent branch.
 *
 * With no interactionIds this preserves the existing full-history fork. With a
 * selection it builds a new feed from the authoritative interaction boundaries
 * in the database, starts with zero usage and no pending proposals, and leaves
 * the source untouched. Either form gets a fresh Claude session; the first reply
 * seeds that session with the copied transcript.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const decoded = await request.json().catch(() => ({}));
  const parsed = parseWith(FeedForkRequestSchema, decoded);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const database = await ensureDatabase();
  const source = database.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();
  if (!source) {
    return Response.json({ error: "Snippet not found." }, { status: 404 });
  }

  const messages = database
    .select()
    .from(feedMessages)
    .where(eq(feedMessages.snippetId, id))
    .orderBy(asc(feedMessages.createdAt))
    .all();
  const selectedFork = parsed.data.interactionIds !== undefined;
  let selectedHistory: ReturnType<typeof selectFeedHistory<typeof messages[number]>> | null = null;
  if (parsed.data.interactionIds) {
    try {
      selectedHistory = selectFeedHistory({
        instruction: source.instruction,
        openingAttachments: source.attachments,
        messages,
        interactionIds: parsed.data.interactionIds,
        includeToolDetails: parsed.data.includeToolDetails,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "The selected history is invalid." },
        { status: 400 },
      );
    }
  }

  const forkId = `feed-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const sourceWorkingDir = feedWorkingDir(id);
  const targetWorkingDir = feedWorkingDir(forkId);
  const historyMessages = selectedHistory?.messages ?? messages;
  const openingRaw = selectedHistory?.openingAttachments ?? source.attachments;
  const openingAttachments = serializedAttachments(
    copyFeedHistoryAttachments(sourceWorkingDir, targetWorkingDir, openingRaw),
  );
  const copiedMessages = historyMessages.map((message) => ({
    source: message,
    id: `msg-${crypto.randomUUID()}`,
    attachments: serializedAttachments(
      copyFeedHistoryAttachments(sourceWorkingDir, targetWorkingDir, message.attachments),
    ),
  }));
  const messageIds = new Map(copiedMessages.map((message) => [message.source.id, message.id]));
  const proposals = selectedFork
    ? []
    : database.select().from(feedProposals).where(eq(feedProposals.snippetId, id)).all();

  database.transaction((tx) => {
    tx.insert(feedSnippets).values({
      id: forkId,
      title: `${selectedFork ? "Selected from" : "Fork of"} ${source.title || source.instruction || "Untitled"}`.slice(0, 200),
      instruction: selectedHistory?.instruction ?? source.instruction,
      status: selectedFork
        ? "done"
        : source.status === "running" || source.status === "queued" ? "done" : source.status,
      sessionId: "",
      model: source.model,
      effort: source.effort,
      historyMode: selectedFork
        ? (parsed.data.includeToolDetails ? "tools" : "conversation")
        : source.historyMode,
      attachments: openingAttachments,
      inputTokens: selectedFork ? 0 : source.inputTokens,
      outputTokens: selectedFork ? 0 : source.outputTokens,
      durationMs: selectedFork ? 0 : source.durationMs,
      turns: selectedFork ? 0 : source.turns,
      createdAt: now,
      updatedAt: now,
    }).run();
    for (const message of copiedMessages) {
      tx.insert(feedMessages).values({
        id: message.id,
        snippetId: forkId,
        role: message.source.role,
        kind: message.source.kind,
        content: message.source.content,
        toolUseId: message.source.toolUseId,
        attachments: message.attachments,
        createdAt: message.source.createdAt,
      }).run();
    }
    for (const proposal of proposals) {
      tx.insert(feedProposals).values({
        id: `prop-${crypto.randomUUID()}`,
        snippetId: forkId,
        messageId: proposal.messageId ? (messageIds.get(proposal.messageId) ?? null) : null,
        operation: proposal.operation,
        status: proposal.status,
        resultSummary: proposal.resultSummary,
        createdAt: proposal.createdAt,
        resolvedAt: proposal.resolvedAt,
      }).run();
    }
  });

  return Response.json({ id: forkId });
}
