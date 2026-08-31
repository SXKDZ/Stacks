import {
  DEFAULT_EXTRACTION_SYSTEM_PROMPT,
  pageSliceFor,
  renderPromptTemplate,
} from "@/app/lib/ai-prompts";
import {
  BedrockInvocationError,
  invokeBedrockMessages,
  temperatureOption,
} from "@/app/lib/bedrock";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import { readPdfPagesFromDocument } from "@/app/lib/pdf-text";
import { getDocumentProxy, getMeta } from "unpdf";
import { parseJsonWith } from "@/app/lib/schemas/parse";
import { effortSetting } from "@/app/lib/effort";
import { ExtractedMetadataSchema } from "@/app/lib/schemas/requests";

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

function authorNamesFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(cleanString).filter(Boolean)
    : cleanString(value).split(/\s*(?:;|\band\b)\s*/i).map((author) => author.trim()).filter(Boolean);
}

function normalizeMetadata(value: Record<string, unknown>, fallback: ExtractedMetadata): ExtractedMetadata {
  const authors = authorNamesFrom(value.authors);
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
    preprintId: cleanNullable(value.preprintId || value.preprint_id) ?? fallback.preprintId,
  };
}

function stripJsonFence(value: string): string {
  return value.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

async function recoverAuthors(input: {
  sourceText: string;
  embeddedMetadata: Record<string, unknown>;
  token: string;
  region: string;
  model: string;
  effort: ReturnType<typeof effortSetting>;
  sendTemperature: boolean;
}): Promise<string[]> {
  const result = await invokeBedrockMessages({
    token: input.token,
    region: input.region,
    model: input.model,
    system: [
      "Extract the complete ordered author list for this academic paper.",
      "Use only the supplied title-page text and embedded PDF metadata.",
      "Return one JSON object with exactly one key, authors, whose value is an array",
      "of every listed author name in first-name-first order. Never use et al.",
      "If no author names are present, return {\"authors\":[]}.",
      `Embedded metadata: ${JSON.stringify(input.embeddedMetadata)}`,
      `Title-page text:\n${input.sourceText}`,
    ].join(" "),
    messages: [{ role: "user", content: "Return the author-list JSON now." }],
    maxTokens: 1200,
    effort: input.effort,
    temperature: temperatureOption(input.sendTemperature, 0),
  });
  // A very long author list can reach the ceiling. Saying so beats reporting the
  // resulting invalid JSON, which reads like the model misbehaved.
  if (result.truncated) {
    throw new Error("The author list reached the 1,200 token ceiling for this step and was cut off.");
  }
  const parsed = parseJsonWith(ExtractedMetadataSchema, stripJsonFence(result.content));
  return parsed.ok ? authorNamesFrom(parsed.data.authors) : [];
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
    // A body cut short still starts with %PDF- and pdf.js will happily read the
    // pages that survived, so metadata would be extracted from a mutilated
    // document and look validated. Content-Length describes the whole file.
    if (declaredLength > 0 && bytes.length !== declaredLength) {
      return Response.json(
        { error: `The upload is incomplete: ${bytes.length} of ${declaredLength} bytes arrived.` },
        { status: 400 },
      );
    }
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
      const warning = fallback.authors.length
        ? "Bedrock is not configured; Stacks used embedded PDF metadata and text heuristics."
        : "Bedrock is not configured, and the PDF metadata did not contain an author list. Review the authors before saving.";
      return Response.json({ metadata: fallback, analyzedPages: pageCount, totalPages: document.numPages, usedFallback: true, warning });
    }

    const region = runtimeValue(runtime, "AWS_REGION", "us-east-1");
    const model = runtimeValue(runtime, "BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6");
    const effort = effortSetting(runtimeValue(runtime, "STACKS_EFFORT"));
    const sendTemperature = runtimeValue(runtime, "STACKS_SEND_TEMPERATURE", "true") !== "false";

    const prompt = renderPromptTemplate(template, {
      filename,
      embedded_metadata: JSON.stringify(info),
      source_text: sourceText,
    });
    try {
      const result = await invokeBedrockMessages({
        token,
        region,
        model,
        system: prompt,
        messages: [{ role: "user", content: "Extract the paper metadata now and return only the requested JSON object." }],
        maxTokens: 1800,
        // Extraction wants deterministic output, but a model that rejects the
        // parameter must not fail the whole import over it.
        effort,
        temperature: temperatureOption(sendTemperature, 0),
      });
      if (result.truncated) {
        throw new Error("The metadata reply reached the 1,800 token ceiling for this step and was cut off.");
      }
      // The model's JSON: validated as an object before normalizeMetadata reads
      // fields off it, so a non-object reply (a bare string, an array, prose)
      // falls into the catch below and returns the heuristic fallback.
      const parsed = parseJsonWith(ExtractedMetadataSchema, stripJsonFence(result.content));
      if (!parsed.ok) {
        throw new Error(`The model did not return usable metadata JSON: ${parsed.error}`);
      }
      let metadata = normalizeMetadata(parsed.data, fallback);
      // Some otherwise-valid model replies omit `authors`, and the PDF's
      // embedded Author field is often empty. A focused title-page pass recovers
      // the list instead of silently saving an authorless record.
      if (!metadata.authors.length) {
        const recovered = await recoverAuthors({
          sourceText,
          embeddedMetadata: info,
          token,
          region,
          model,
          effort,
          sendTemperature,
        }).catch(() => []);
        if (recovered.length) metadata = { ...metadata, authors: recovered };
      }
      return Response.json({
        metadata,
        analyzedPages: pageCount,
        totalPages: document.numPages,
        usedFallback: false,
        endpoint: result.endpoint,
        ...(!metadata.authors.length
          ? { warning: "No author list was found in the analyzed PDF pages. Review the authors before saving." }
          : {}),
      });
    } catch (error) {
      const warning = error instanceof BedrockInvocationError
        ? `Bedrock returned ${error.status}: ${error.message}`
        : error instanceof Error ? error.message : "Metadata extraction failed.";
      return Response.json({
        metadata: fallback,
        analyzedPages: pageCount,
        totalPages: document.numPages,
        usedFallback: true,
        warning: fallback.authors.length
          ? warning
          : `${warning} No author list was found; review the authors before saving.`,
      });
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "The PDF could not be read." }, { status: 422 });
  } finally {
    await document?.destroy().catch(() => undefined);
  }
}
