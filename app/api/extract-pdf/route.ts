import {
  DEFAULT_EXTRACTION_SYSTEM_PROMPT,
  pageSliceFor,
  renderPromptTemplate,
} from "@/app/lib/ai-prompts";
import {
  BedrockInvocationError,
  invokeBedrockMessages,
} from "@/app/lib/bedrock";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import { readPdfPagesFromDocument } from "@/app/lib/pdf-text";
import { getDocumentProxy, getMeta } from "unpdf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ExtractedMetadata {
  title: string;
  authors: string[];
  abstract: string;
  year: number | null;
  venueName: string;
  venueAcronym: string;
  paperType: "conference" | "journal" | "workshop" | "preprint" | "other";
  doi: string | null;
  url: string | null;
  category: string | null;
  preprintId: string | null;
}

const allowedPaperTypes = new Set<ExtractedMetadata["paperType"]>([
  "conference",
  "journal",
  "workshop",
  "preprint",
  "other",
]);

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanNullable(value: unknown): string | null {
  const cleaned = cleanString(value);
  return cleaned || null;
}

function cleanYear(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1500 && parsed <= 2200 ? parsed : null;
}

function normalizeMetadata(value: Record<string, unknown>, fallback: ExtractedMetadata): ExtractedMetadata {
  const authors = Array.isArray(value.authors)
    ? value.authors.map(cleanString).filter(Boolean)
    : cleanString(value.authors).split(/\s*(?:;|\band\b)\s*/i).map((author) => author.trim()).filter(Boolean);
  const paperType = cleanString(value.paperType || value.paper_type).toLowerCase() as ExtractedMetadata["paperType"];
  return {
    title: cleanString(value.title) || fallback.title,
    authors: authors.length ? authors : fallback.authors,
    abstract: cleanString(value.abstract) || fallback.abstract,
    year: cleanYear(value.year) ?? fallback.year,
    venueName: cleanString(value.venueName || value.venue_full) || fallback.venueName,
    venueAcronym: cleanString(value.venueAcronym || value.venue_acronym) || fallback.venueAcronym,
    paperType: allowedPaperTypes.has(paperType) ? paperType : fallback.paperType,
    doi: cleanNullable(value.doi) ?? fallback.doi,
    url: cleanNullable(value.url) ?? fallback.url,
    category: cleanNullable(value.category) ?? fallback.category,
    preprintId: cleanNullable(value.preprintId || value.preprint_id || value.arxivId) ?? fallback.preprintId,
  };
}

function stripJsonFence(value: string): string {
  return value.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function fallbackMetadata(text: string, info: Record<string, unknown>, filename: string): ExtractedMetadata {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const titleFromText = lines.find((line) => (
    line.length >= 12
    && line.length <= 300
    && !/^(abstract|arxiv|preprint|proceedings|page\s+\d+)/i.test(line)
  ));
  const title = cleanString(info.Title) || titleFromText || filename.replace(/\.pdf$/i, "");
  const embeddedAuthors = cleanString(info.Author)
    .split(/\s*(?:;|\band\b)\s*/i)
    .map((author) => author.trim())
    .filter(Boolean);
  const yearMatch = `${cleanString(info.CreationDate)}\n${text.slice(0, 20000)}`.match(/\b(?:19|20)\d{2}\b/);
  const arxivMatch = text.slice(0, 20000).match(/(?:arXiv\s*:?\s*)(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  return {
    title,
    authors: embeddedAuthors,
    abstract: "",
    year: yearMatch ? Number(yearMatch[0]) : null,
    venueName: arxivMatch ? "arXiv" : "",
    venueAcronym: arxivMatch ? "arXiv" : "",
    paperType: arxivMatch ? "preprint" : "other",
    doi: null,
    url: null,
    category: null,
    preprintId: arxivMatch ? `arXiv ${arxivMatch[1]}` : null,
  };
}

export async function POST(request: Request): Promise<Response> {
  const filename = decodeURIComponent(request.headers.get("X-Stacks-File-Name") || "paper.pdf");
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > 50 * 1024 * 1024) {
    return Response.json({ error: "The PDF exceeds the 50 MB extraction limit." }, { status: 413 });
  }

  let document: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > 50 * 1024 * 1024) {
      return Response.json({ error: bytes.length ? "The PDF exceeds the 50 MB extraction limit." : "The PDF is empty." }, { status: 400 });
    }
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
      return Response.json({ error: "The selected file does not appear to be a valid PDF." }, { status: 400 });
    }

    document = await getDocumentProxy(bytes);
    const runtime = await resolveRuntimeValues();
    const template = runtimeValue(runtime, "STACKS_EXTRACTION_SYSTEM_PROMPT", DEFAULT_EXTRACTION_SYSTEM_PROMPT);
    // The {{source_text}} placeholder controls how many pages to read, e.g.
    // {{source_text[1:2]}}. Default (no slice) reads the first two pages.
    const slice = pageSliceFor(template, "source_text") ?? { start: 1, end: 2 };
    const { text: sourceText, firstPage, lastPage } = await readPdfPagesFromDocument(document, slice);
    const pageCount = Math.max(0, lastPage - firstPage + 1);
    if (!sourceText) {
      return Response.json({ error: `No selectable text was found in PDF pages ${firstPage}-${lastPage}.` }, { status: 422 });
    }
    const embedded = await getMeta(document).catch(() => ({ info: {}, metadata: null }));
    const info = embedded.info ?? {};
    const fallback = fallbackMetadata(sourceText, info, filename);
    const token = runtimeValue(runtime, "AWS_BEARER_TOKEN_BEDROCK");
    if (!token) {
      return Response.json({ metadata: fallback, analyzedPages: pageCount, totalPages: document.numPages, usedFallback: true, warning: "Bedrock is not configured; Stacks used embedded PDF metadata and text heuristics." });
    }

    const prompt = renderPromptTemplate(template, {
      filename,
      embedded_metadata: JSON.stringify(info),
      source_text: sourceText,
    });
    try {
      const result = await invokeBedrockMessages({
        token,
        region: runtimeValue(runtime, "AWS_REGION", "us-east-1"),
        model: runtimeValue(runtime, "BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6"),
        system: prompt,
        messages: [{ role: "user", content: "Extract the paper metadata now and return only the requested JSON object." }],
        maxTokens: 1800,
        temperature: 0,
      });
      const parsed = JSON.parse(stripJsonFence(result.content)) as Record<string, unknown>;
      return Response.json({
        metadata: normalizeMetadata(parsed, fallback),
        analyzedPages: pageCount,
        totalPages: document.numPages,
        usedFallback: false,
        endpoint: result.endpoint,
      });
    } catch (error) {
      const warning = error instanceof BedrockInvocationError
        ? `Bedrock returned ${error.status}: ${error.message}`
        : error instanceof Error ? error.message : "Metadata extraction failed.";
      return Response.json({ metadata: fallback, analyzedPages: pageCount, totalPages: document.numPages, usedFallback: true, warning });
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "The PDF could not be read." }, { status: 422 });
  } finally {
    await document?.destroy().catch(() => undefined);
  }
}
