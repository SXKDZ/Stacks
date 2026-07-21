import { asc, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";
import { requireFeedEnabled } from "@/app/lib/feed-access";
import { isFeedRunning, subscribeFeed } from "@/app/lib/feed-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const blocked = requireFeedEnabled();
  if (blocked) {
    return blocked;
  }
  const { id } = await context.params;
  const database = await ensureDatabase();
  const snippet = database.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();
  if (!snippet) {
    return Response.json({ error: "Snippet not found." }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      // Replay persisted history first so a late/reconnecting client is caught up.
      const messages = database
        .select()
        .from(feedMessages)
        .where(eq(feedMessages.snippetId, id))
        .orderBy(asc(feedMessages.createdAt))
        .all();
      for (const message of messages) {
        controller.enqueue(frame("message", {
          id: message.id,
          role: message.role,
          kind: message.kind,
          content: message.content,
          toolUseId: message.toolUseId,
          createdAt: message.createdAt,
        }));
      }
      const proposals = database
        .select()
        .from(feedProposals)
        .where(eq(feedProposals.snippetId, id))
        .all();
      for (const proposal of proposals) {
        let summary = "Proposed change";
        try {
          summary = (JSON.parse(proposal.operation) as { summary?: string }).summary ?? summary;
        } catch {
          // Keep the default summary if the stored operation isn't parseable.
        }
        controller.enqueue(frame("proposal", {
          id: proposal.id,
          operation: proposal.operation,
          status: proposal.status,
          summary,
          createdAt: proposal.createdAt,
        }));
      }

      // If the run already finished, send the terminal status and close.
      if (!isFeedRunning(id)) {
        controller.enqueue(frame("done", { status: snippet.status }));
        controller.close();
        return;
      }

      controller.enqueue(frame("status", { status: "running" }));
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
