import { mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { feedWorkingDir } from "@/app/lib/feed-agent";
import { revealDirectory } from "@/app/lib/local-files";
import { ensureDatabase } from "@/db/bootstrap";
import { feedSnippets } from "@/db/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function existingWorkingDirectory(id: string): Promise<string | null> {
  const database = await ensureDatabase();
  const snippet = database
    .select({ id: feedSnippets.id })
    .from(feedSnippets)
    .where(eq(feedSnippets.id, id))
    .get();
  return snippet ? feedWorkingDir(id) : null;
}

/** Return the absolute managed path so the detail view can display it. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const workingDirectory = await existingWorkingDirectory(id);
    if (!workingDirectory) {
      return Response.json({ error: "Feed not found." }, { status: 404 });
    }
    return Response.json({ path: workingDirectory });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The working directory could not be resolved." },
      { status: 400 },
    );
  }
}

/** Open one feed's managed workspace in the local file browser. The client sends
 * only the feed id: the absolute path is resolved and validated on the server. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const workingDirectory = await existingWorkingDirectory(id);
    if (!workingDirectory) {
      return Response.json({ error: "Feed not found." }, { status: 404 });
    }
    // Historical feeds may predate working directories. Creating the managed
    // location here gives every feed a stable place for later agent output.
    mkdirSync(workingDirectory, { recursive: true });
    await revealDirectory(workingDirectory);
    return Response.json({ ok: true, path: workingDirectory });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The working directory could not be opened." },
      { status: 400 },
    );
  }
}
