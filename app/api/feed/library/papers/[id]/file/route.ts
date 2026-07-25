import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { papers } from "@/db/schema";
import { snippetForToken } from "@/app/lib/feed-token";
import { resolveStoredFile, servePdfFile, serveHtmlSnapshot } from "@/app/lib/local-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Agent-facing file download for one library paper: streams the paper's stored
 * PDF (or its HTML snapshot when there is no PDF) so the agent can fetch the
 * ORIGINAL with `curl`/`wget` into its scratch dir and read it, instead of us
 * eagerly copying every attached paper into the feed working directory.
 *
 * Read-only and token-gated (same per-run bearer token as /api/feed/library).
 * The paper's on-disk name comes from the DB, and resolveStoredFile confines it
 * to the managed pdfs/ | html_snapshots/ dirs (no path traversal). PDF supports
 * Range requests via servePdfFile; HTML is script-stripped by serveHtmlSnapshot.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!snippetForToken(request.headers.get("authorization") ?? request.headers.get("x-stacks-feed-token"))) {
    return Response.json({ error: "Unauthorized: a valid feed token is required." }, { status: 401 });
  }
  const { id } = await context.params;
  const database = await ensureDatabase();
  const paper = database
    .select({ localPath: papers.localPath, htmlSnapshotPath: papers.htmlSnapshotPath })
    .from(papers)
    .where(eq(papers.id, id))
    .get();
  if (!paper) {
    return Response.json({ error: "Paper not found." }, { status: 404 });
  }
  // Prefer the PDF, but only if it is really on disk. resolveStoredFile validates
  // the NAME, not its existence, so a stale local_path (the file was moved or the
  // library restored without it) used to enter this branch and 404 without ever
  // trying the HTML snapshot the paper actually still has.
  if (paper.localPath) {
    const resolved = resolveStoredFile("pdfs", paper.localPath);
    if (resolved && existsSync(resolved.path)) {
      return servePdfFile(resolved.path, request.headers.get("range"));
    }
  }
  if (paper.htmlSnapshotPath) {
    const resolved = resolveStoredFile("html", paper.htmlSnapshotPath);
    if (resolved && existsSync(resolved.path)) {
      return serveHtmlSnapshot(resolved.path);
    }
  }
  return Response.json({ error: "This paper has no stored file. Use its url/pdfUrl metadata instead." }, { status: 404 });
}
