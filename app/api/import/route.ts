import { captureWebpageSnapshot } from "@/app/lib/webpage-snapshot";
import { parseRequest } from "@/app/lib/schemas/parse";
import { ImportUrlRequestSchema } from "@/app/lib/schemas/requests";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function validPublicUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    // Snapshots require https (the WebKit capture and SSRF guard both enforce it).
    if (url.protocol !== "https:") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const requested = await parseRequest(ImportUrlRequestSchema, request);
    const sourceUrl = requested.ok ? requested.data.url : "";
    const parsed = sourceUrl ? validPublicUrl(sourceUrl) : null;
    if (!parsed) {
      return Response.json({ error: "Enter a valid public https:// URL." }, { status: 400 });
    }
    // Render the page locally (headless WebKit). Throws on a challenge/error
    // page so we never import metadata scraped from a verification screen.
    const snapshot = await captureWebpageSnapshot(parsed);
    const arxivMatch = sourceUrl.match(/arxiv\.org\/(?:abs|pdf)\/([^?#/]+)/i);
    return Response.json({
      source: "Web snapshot",
      title: snapshot.title || parsed.hostname,
      abstract: snapshot.text.slice(0, 1200),
      url: snapshot.finalUrl || sourceUrl,
      pdfUrl: sourceUrl.toLowerCase().includes(".pdf") ? sourceUrl : null,
      arxivId: arxivMatch?.[1]?.replace(/\.pdf$/i, "") ?? null,
      readerContent: snapshot.text.slice(0, 14000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "URL import failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
