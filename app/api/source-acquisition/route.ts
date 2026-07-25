import { acquireSource } from "@/app/lib/local-files";
import { parseRequest } from "@/app/lib/schemas/parse";
import { SourceAcquisitionRequestSchema } from "@/app/lib/schemas/requests";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = await parseRequest(SourceAcquisitionRequestSchema, request);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    return Response.json(await acquireSource(parsed.data));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The paper source could not be acquired." },
      { status: 400 },
    );
  }
}
