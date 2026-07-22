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

/** Update a feed's editable fields: its title (rename) and/or its note body. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { title?: string; note?: string; workflowSteps?: unknown };
  const database = await ensureDatabase();
  const snippet = database.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();
  if (!snippet) {
    return Response.json({ error: "Snippet not found." }, { status: 404 });
  }
  const changes: { title?: string; note?: string; workflowSteps?: string | null; updatedAt: string } = { updatedAt: new Date().toISOString() };
  if (typeof body.title === "string") {
    const title = body.title.trim();
    if (!title) {
      return Response.json({ error: "Enter a title." }, { status: 400 });
    }
    changes.title = title.slice(0, 200);
  }
  // The note is free-form and may be intentionally cleared, so an empty string
  // is a valid value (unlike the title).
  if (typeof body.note === "string") {
    changes.note = body.note.slice(0, 20000);
  }
  // Advancing a workflow rewrites the remaining-steps queue (empty array clears
  // it once the last step has run).
  if (Array.isArray(body.workflowSteps)) {
    changes.workflowSteps = body.workflowSteps.length ? JSON.stringify(body.workflowSteps) : null;
  }
  database.update(feedSnippets).set(changes).where(eq(feedSnippets.id, id)).run();
  return Response.json({ ok: true, title: changes.title ?? snippet.title, note: changes.note ?? snippet.note });
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
