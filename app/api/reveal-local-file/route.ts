import { portableStoredName, revealLocalFile, type RevealLocalFileRequest } from "@/app/lib/local-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const payload = await request.json() as RevealLocalFileRequest;
    if (payload.kind !== "pdf" && payload.kind !== "html") {
      throw new Error("Choose a stored PDF or HTML snapshot.");
    }
    const name = portableStoredName(payload.path, payload.kind);
    if (!name) {
      throw new Error("No stored file was selected.");
    }
    revealLocalFile(payload.kind, name);
    return Response.json({ ok: true, name });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The stored file could not be revealed." },
      { status: 400 },
    );
  }
}
