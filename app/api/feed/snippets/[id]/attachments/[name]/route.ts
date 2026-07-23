import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { feedWorkingDir } from "@/app/lib/feed-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  json: "application/json",
  csv: "text/csv; charset=utf-8",
};

// Renderable markup (a paper's HTML snapshot, an uploaded .html/.svg) is
// untrusted: it can carry <script> that would run in the app's own origin and
// drive its APIs. Attachments are raw files, not the curated reader view, so we
// never serve them inline as HTML. These extensions are forced to download as
// an opaque octet-stream instead of being rendered.
const NEVER_RENDER = new Set(["html", "htm", "svg", "xhtml", "xml", "mhtml"]);

/**
 * Serve a file the user attached to a feed turn, staged under the feed's
 * working dir at `attachments/<name>`. The name is confined to a single path
 * segment inside that folder (no traversal), mirroring the local-files guard.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; name: string }> },
): Promise<Response> {
  const { id, name } = await context.params;
  const requested = decodeURIComponent(name);
  // Reject anything that isn't a bare filename (blocks "..", slashes, etc.).
  if (!requested || basename(requested) !== requested || requested === "." || requested === "..") {
    return Response.json({ error: "Invalid attachment name." }, { status: 400 });
  }
  const directory = join(feedWorkingDir(id), "attachments");
  const filePath = join(directory, requested);
  if (resolve(filePath) !== filePath || !resolve(filePath).startsWith(resolve(directory) + sep)) {
    return Response.json({ error: "Invalid attachment path." }, { status: 400 });
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return Response.json({ error: "Attachment not found." }, { status: 404 });
  }
  const ext = requested.slice(requested.lastIndexOf(".") + 1).toLowerCase();
  const bytes = readFileSync(filePath);
  const renderable = !NEVER_RENDER.has(ext);
  const safeName = requested.replace(/"/g, "");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": renderable ? (CONTENT_TYPES[ext] ?? "application/octet-stream") : "application/octet-stream",
      "Content-Disposition": `${renderable ? "inline" : "attachment"}; filename="${safeName}"`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
      // Defense in depth: even if a client renders the response, nothing loads
      // or executes. Harmless for the download path.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
