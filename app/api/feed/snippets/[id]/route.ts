import { rmSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";
import { feedWorkingDir, isFeedRunning, stopFeedAndWait } from "@/app/lib/feed-agent";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import { patchIssueState, type GitHubConfig } from "@/app/lib/github-sync";

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
  const snippet = database.select({ issueNumber: feedSnippets.issueNumber }).from(feedSnippets).where(eq(feedSnippets.id, id)).get();

  // If this feed was mirrored to a GitHub issue, close that issue as part of the
  // delete. Inbound sync only reads OPEN issues, so an open issue with no local
  // feed is treated as brand-new and recreated from its title+body — meaning a
  // deleted feed would otherwise reappear (rebuilt from scratch) on the next
  // sync. Closing it is the tombstone. Best-effort: GitHub being unconfigured or
  // unreachable must not block the local delete.
  if (snippet?.issueNumber) {
    try {
      const runtime = await resolveRuntimeValues();
      const repo = runtimeValue(runtime, "STACKS_GITHUB_REPO");
      const token = runtimeValue(runtime, "GITHUB_TOKEN");
      if (repo && token) {
        const config: GitHubConfig = { repo, token };
        await patchIssueState(config, snippet.issueNumber, "closed");
      }
    } catch {
      // Leave the issue open if we can't reach GitHub; the user can close it,
      // or a future sync of a still-open issue will recreate the feed.
    }
  }

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
