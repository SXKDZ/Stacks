import { parseBibliography, type BibliographyFormat } from "@/app/lib/bibliography";

export const dynamic = "force-dynamic";

interface ImportRequest {
  content?: string;
  format?: BibliographyFormat;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as ImportRequest;
    if (body.format !== "bibtex" && body.format !== "ris") {
      return Response.json({ error: "Choose a BibTeX or RIS file." }, { status: 400 });
    }
    if (!body.content?.trim()) {
      return Response.json({ error: "The selected bibliography file is empty." }, { status: 400 });
    }
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
