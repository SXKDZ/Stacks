import { acquireSource, type SourceAcquisitionRequest } from "@/app/lib/local-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const payload = await request.json() as SourceAcquisitionRequest;
    return Response.json(await acquireSource(payload));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The paper source could not be acquired." },
      { status: 400 },
    );
  }
}
