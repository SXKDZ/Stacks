import { importIdentifier } from "@/app/lib/scholarly";
import { parseRequest } from "@/app/lib/schemas/parse";
import { ImportIdentifierRequestSchema } from "@/app/lib/schemas/requests";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = await parseRequest(ImportIdentifierRequestSchema, request);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    const { identifier, source } = parsed.data;
    const paper = await importIdentifier(source, identifier);
    return Response.json({ source, paper });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Identifier import failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
