import { GET as libraryGet } from "@/app/api/library/route";
import { snippetForToken } from "@/app/lib/feed-token";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Agent-facing metadata for one library paper. The feed agent authenticates with
 * its per-run bearer token (same as /api/feed/library) and reads a single
 * paper's full record — including whether a local PDF / HTML snapshot exists and
 * the file URL to fetch it from (see ./file). Read-only, no approval gate.
 *
 * Backed by the same snapshot the library uses, so the fields match exactly what
 * GET /api/feed/library returns per paper (no separate query to drift).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!snippetForToken(request.headers.get("authorization") ?? request.headers.get("x-stacks-feed-token"))) {
    return Response.json({ error: "Unauthorized: a valid feed token is required." }, { status: 401 });
  }
  const { id } = await context.params;
  const snapshot = (await (await libraryGet()).json()) as { papers?: Array<Record<string, unknown>> };
  const paper = snapshot.papers?.find((candidate) => candidate.id === id);
  if (!paper) {
    return Response.json({ error: "Paper not found." }, { status: 404 });
  }
  // Return the paper's fields with hasFile/fileUrl merged in, so the agent reads
  // one flat object (paper.hasFile / paper.fileUrl) rather than digging for a
  // sibling. fileUrl points at the token-gated file endpoint below, NOT the
  // app's own /stacks-files URL (which needs a browser session, not the token).
  const hasFile = Boolean(paper.localPath || paper.htmlSnapshotPath);
  return Response.json({
    ...paper,
    hasFile,
    fileUrl: hasFile ? `/api/feed/library/papers/${encodeURIComponent(id)}/file` : null,
  });
}
