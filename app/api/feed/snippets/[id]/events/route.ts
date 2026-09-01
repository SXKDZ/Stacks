import { asc, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";
import { isFeedRunning, subscribeFeed } from "@/app/lib/feed-agent";
import { AGENT_MESSAGE_ROLES, effectiveFeedStatus } from "@/app/lib/feed-status";
import { storedProposalSummary } from "@/app/lib/schemas/proposals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const database = await ensureDatabase();
  const snippet = database.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();
  if (!snippet) {
    return Response.json({ error: "Snippet not found." }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const messages = database
    .select()
    .from(feedMessages)
    .where(eq(feedMessages.snippetId, id))
    .orderBy(asc(feedMessages.createdAt))
    .all();
  const running = isFeedRunning(id);
  // The newest AGENT-written row, not the newest row: a system note (an approval
  // decision, a model switch) is not output from a run that outlived its turn.
  const latestAgentMessageAt = messages.filter((message) => AGENT_MESSAGE_ROLES.includes(message.role)).at(-1)?.createdAt;
  const effectiveSnippet = effectiveFeedStatus(snippet, latestAgentMessageAt, running);
  const proposals = database
    .select()
    .from(feedProposals)
    .where(eq(feedProposals.snippetId, id))
    .all()
    .map((proposal) => {
      return {
        id: proposal.id,
        messageId: proposal.messageId,
        operation: proposal.operation,
        status: proposal.status,
        summary: storedProposalSummary(proposal.operation, "Proposed change"),
        createdAt: proposal.createdAt,
      };
    });

  const stream = new ReadableStream({
    start(controller) {
      // Persisted history is one atomic snapshot. Replaying thousands of rows as
      // individual SSE events made React rebuild the growing thread once per row
      // before the browser could settle. SSE remains responsible only for events
      // produced after this snapshot while a feed is live.
      controller.enqueue(frame("snapshot", {
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role,
          kind: message.kind,
          content: message.content,
          toolUseId: message.toolUseId,
          attachments: message.attachments,
          inputTokens: message.inputTokens,
          outputTokens: message.outputTokens,
          durationMs: message.durationMs,
          createdAt: message.createdAt,
        })),
        proposals,
      }));

      // If the run already finished, send the terminal status and close.
      if (!running) {
        controller.enqueue(frame("done", { status: effectiveSnippet.status }));
        controller.close();
        return;
      }

      // The event is the replay boundary; its body was never read.
      controller.enqueue(frame("status", {}));
      let closed = false;
      const unsubscribe = subscribeFeed(id, (event) => {
        if (closed) {
          return;
        }
        try {
          if (event.type === "done") {
            controller.enqueue(frame("done", { status: event.status }));
            closed = true;
            unsubscribe();
            controller.close();
          } else {
            controller.enqueue(frame(event.type, event));
          }
        } catch {
          closed = true;
          unsubscribe();
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
