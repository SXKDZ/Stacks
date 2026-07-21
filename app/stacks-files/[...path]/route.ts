import { resolveStoredFile, servePdfFile, serveHtmlSnapshot } from "@/app/lib/local-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params;
  const kind = path[0];
  const requestedName = decodeURIComponent(path.slice(1).join("/"));
  const resolved = resolveStoredFile(kind, requestedName);
  if (!resolved) {
    return Response.json({ error: "Invalid local file path." }, { status: 400 });
  }
  if (resolved.kind === "pdf") {
    return servePdfFile(resolved.path, request.headers.get("range"));
  }
  return serveHtmlSnapshot(resolved.path);
}
