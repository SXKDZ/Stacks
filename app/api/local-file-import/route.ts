import { importLocalFile } from "@/app/lib/local-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    return Response.json(await importLocalFile(request));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The local file could not be loaded." },
      { status: 400 },
    );
  }
}
