import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { feedWorkingDir } from "@/app/lib/feed-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
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
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "Content-Disposition": `inline; filename="${requested.replace(/"/g, "")}"`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
    },
  });
}
