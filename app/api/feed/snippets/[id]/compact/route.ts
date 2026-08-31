import { eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedSnippets } from "@/db/schema";
import { compactFeedSession } from "@/app/lib/feed-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Compact this thread's agent session: the `/compact` of the interactive client,
 * run headlessly against the session Stacks resumes.
 *
 * Only what the agent carries between turns gets shorter. The thread the user reads
 * is stored separately and is untouched, which is what makes this the non-destructive
 * option beside a rewind.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const database = await ensureDatabase();
  const snippet = database.select({ id: feedSnippets.id }).from(feedSnippets).where(eq(feedSnippets.id, id)).get();
  if (!snippet) {
    return Response.json({ error: "Snippet not found." }, { status: 404 });
  }

  const result = await compactFeedSession(id);
  // A refusal here is a state the user can act on (no session yet, a turn running),
  // not a server fault, so it is a 409 with the reason rather than a 500.
  return result.ok
    ? Response.json({ message: result.message })
    : Response.json({ error: result.message }, { status: 409 });
}
