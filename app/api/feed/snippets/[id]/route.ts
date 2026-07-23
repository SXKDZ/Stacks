import { rmSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";
import { feedWorkingDir, isFeedRunning, stopFeedAndWait } from "@/app/lib/feed-agent";

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

/** Update a feed's editable fields: its title (rename) and collapsed state. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { title?: string; collapsed?: boolean };
  const database = await ensureDatabase();
  const snippet = database.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();
  if (!snippet) {
    return Response.json({ error: "Snippet not found." }, { status: 404 });
  }
  const changes: { title?: string; collapsed?: boolean; updatedAt?: string } = {};
  if (typeof body.title === "string") {
    const title = body.title.trim();
    if (!title) {
      return Response.json({ error: "Enter a title." }, { status: 400 });
    }
    changes.title = title.slice(0, 200);
    // A rename is a content edit, so it bumps the sort timestamp.
    changes.updatedAt = new Date().toISOString();
  }
  // Collapsing/expanding is a shelving action, NOT a content change — leave
  // updatedAt untouched so the feed keeps its place in the list instead of
  // jumping to the top when it's expanded again.
  if (typeof body.collapsed === "boolean") {
    changes.collapsed = body.collapsed;
  }
  if (Object.keys(changes).length) {
    database.update(feedSnippets).set(changes).where(eq(feedSnippets.id, id)).run();
  }
  return Response.json({ ok: true, title: changes.title ?? snippet.title, collapsed: changes.collapsed ?? snippet.collapsed });
}

/** Delete a feed and its messages/proposals (cascade), plus the on-disk working
 *  directory that holds its staged attachments and agent session transcripts. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  // Stop a running agent first so nothing writes back into the dir we remove.
  if (isFeedRunning(id)) {
    await stopFeedAndWait(id);
  }
  const database = await ensureDatabase();
  database.delete(feedSnippets).where(eq(feedSnippets.id, id)).run();
  // Remove the feed/<id> tree (uploaded files + copied library PDFs + session
  // transcripts). Best-effort: a failure here must not fail the delete.
  try {
    rmSync(feedWorkingDir(id), { recursive: true, force: true });
  } catch {
    // The DB rows are already gone; a leftover dir is harmless.
  }
  return Response.json({ ok: true });
}
