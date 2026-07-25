import { parseBibliography } from "@/app/lib/bibliography";
import { parseRequest } from "@/app/lib/schemas/parse";
import { ImportBibliographyRequestSchema } from "@/app/lib/schemas/requests";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = await parseRequest(ImportBibliographyRequestSchema, request);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    const body = parsed.data;
    if (body.content.length > 5_000_000) {
      return Response.json({ error: "Bibliography files must be smaller than 5 MB." }, { status: 413 });
    }
    const papers = parseBibliography(body.content, body.format);
    if (!papers.length) {
      return Response.json({ error: `No paper records were found in this ${body.format === "bibtex" ? "BibTeX" : "RIS"} file.` }, { status: 422 });
    }
    return Response.json({ papers, format: body.format });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The bibliography file could not be parsed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
