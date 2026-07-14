import type { IdentifierSource } from "@/app/lib/types";
import { importIdentifier } from "@/app/lib/scholarly";

export const dynamic = "force-dynamic";

interface ImportRequest {
  source?: IdentifierSource;
  identifier?: string;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json() as ImportRequest;
    const identifier = body.identifier?.trim();
    if (!identifier) {
      return Response.json({ error: "Enter an identifier or record URL." }, { status: 400 });
    }
    const source = body.source ?? "arxiv";
    const paper = await importIdentifier(source, identifier);
    return Response.json({ source, paper });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Identifier import failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
