import { parseBibliography } from "@/app/lib/bibliography";

/** Matches the per-request cap the library write API enforces. */
const BULK_CREATE_LIMIT = 500;
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
    // The library's bulk-create accepts at most 500 records per request and
    // rejects the WHOLE batch beyond that, so a larger file would parse fine here
    // and then fail entirely at the next step. Report the overflow instead, and
    // hand back a batch the importer can actually apply.
    if (papers.length > BULK_CREATE_LIMIT) {
      return Response.json({
        papers: papers.slice(0, BULK_CREATE_LIMIT),
        format: body.format,
        truncated: { parsed: papers.length, imported: BULK_CREATE_LIMIT },
      });
    }
    return Response.json({ papers, format: body.format });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The bibliography file could not be parsed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
