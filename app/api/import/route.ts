import { captureWebpageSnapshot } from "@/app/lib/webpage-snapshot";
import { parseRequest } from "@/app/lib/schemas/parse";
import { ImportUrlRequestSchema } from "@/app/lib/schemas/requests";
import { canonicalPreprintId } from "@/app/lib/preprint-id";

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

function pdfTitle(url: URL): string {
  const filename = decodeURIComponent(url.pathname.split("/").at(-1) ?? "").replace(/\.pdf$/i, "");
  return filename.replace(/[-_]+/g, " ").trim() || url.hostname;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const requested = await parseRequest(ImportUrlRequestSchema, request);
    const sourceUrl = requested.ok ? requested.data.url : "";
    const parsed = sourceUrl ? validPublicUrl(sourceUrl) : null;
    if (!parsed) {
      return Response.json({ error: "Enter a valid public https:// URL." }, { status: 400 });
    }
    // Navigating directly to a PDF makes Playwright abort with "Download is
    // starting". Hand the URL to the source-acquisition path instead; it streams,
    // validates, and stores the PDF without trying to render it as a webpage.
    if (/\.pdf$/i.test(parsed.pathname)) {
      const isArxivHost = /(^|\.)arxiv\.org$/i.test(parsed.hostname);
      const arxivMatch = isArxivHost ? parsed.pathname.match(/^\/(?:abs|pdf)\/([^/]+)$/i) : null;
      return Response.json({
        source: "PDF URL",
        title: pdfTitle(parsed),
        abstract: "",
        url: parsed.toString(),
        pdfUrl: parsed.toString(),
        preprintId: canonicalPreprintId(arxivMatch?.[1]?.replace(/\.pdf$/i, "") ?? null),
        readerContent: "",
      });
    }
    // Render the page locally (headless WebKit). Throws on a challenge/error
    // page so we never import metadata scraped from a verification screen.
    const snapshot = await captureWebpageSnapshot(parsed);
    // Judge identity from the RESOLVED url's host and path, never from the raw
    // request string: matching anywhere in the text let any host claim an arXiv id
    // or PDF identity through its query string
    // (https://evil.example/redir?to=arxiv.org/abs/1234).
    const resolved = (() => {
      try {
        return new URL(snapshot.finalUrl || sourceUrl);
      } catch {
        return parsed;
      }
    })();
    const isArxivHost = /(^|\.)arxiv\.org$/i.test(resolved.hostname);
    const arxivMatch = isArxivHost ? resolved.pathname.match(/^\/(?:abs|pdf)\/([^/]+)$/i) : null;
    const isPdfPath = /\.pdf$/i.test(resolved.pathname);
    return Response.json({
      source: "Web snapshot",
      title: snapshot.title || parsed.hostname,
      abstract: snapshot.text.slice(0, 1200),
      url: snapshot.finalUrl || sourceUrl,
      pdfUrl: isPdfPath ? resolved.toString() : null,
      preprintId: canonicalPreprintId(arxivMatch?.[1]?.replace(/\.pdf$/i, "") ?? null),
      readerContent: snapshot.text.slice(0, 14000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "URL import failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
