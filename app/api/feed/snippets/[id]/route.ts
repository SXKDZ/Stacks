import { asc, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";

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
  const messages = database
    .select()
    .from(feedMessages)
    .where(eq(feedMessages.snippetId, id))
    .orderBy(asc(feedMessages.createdAt))
    .all();
  const proposals = database
    .select()
    .from(feedProposals)
    .where(eq(feedProposals.snippetId, id))
    .all();
  return Response.json({ snippet, messages, proposals });
}

/** Rename a feed (update its title). */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { title?: string };
  const title = body.title?.trim();
  if (!title) {
    return Response.json({ error: "Enter a title." }, { status: 400 });
  }
  const database = await ensureDatabase();
  const snippet = database.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();
  if (!snippet) {
    return Response.json({ error: "Snippet not found." }, { status: 404 });
  }
  database
    .update(feedSnippets)
    .set({ title: title.slice(0, 200), updatedAt: new Date().toISOString() })
    .where(eq(feedSnippets.id, id))
    .run();
  return Response.json({ ok: true, title: title.slice(0, 200) });
}

/** Delete a feed and its messages/proposals (cascade). */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const database = await ensureDatabase();
  database.delete(feedSnippets).where(eq(feedSnippets.id, id)).run();
  return Response.json({ ok: true });
}
