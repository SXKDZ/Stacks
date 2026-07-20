import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";

export const dynamic = "force-dynamic";

interface ImportRequest {
  url?: string;
}

interface ReaderPayload {
  data?: {
    title?: string;
    url?: string;
    content?: string;
    description?: string;
  };
  title?: string;
  url?: string;
  content?: string;
  description?: string;
}

function validPublicUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = await resolveRuntimeValues();
    const body = (await request.json()) as ImportRequest;
    const sourceUrl = body.url?.trim();
    if (!sourceUrl || !validPublicUrl(sourceUrl)) {
      return Response.json({ error: "Enter a valid public URL." }, { status: 400 });
    }
    const apiKey = runtimeValue(runtime, "JINA_API_KEY");
    if (!apiKey) {
      return Response.json({ error: "JINA_API_KEY is not configured." }, { status: 500 });
    }
    const response = await fetch(`https://r.jina.ai/${sourceUrl}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Return-Format": "json",
        "X-No-Cache": "true",
      },
    });
    if (!response.ok) {
      return Response.json(
        { error: `Jina Reader returned ${response.status}.` },
        { status: 502 },
      );
    }
    const payload = (await response.json()) as ReaderPayload;
    const result = payload.data ?? payload;
    const content = result.content ?? "";
    const arxivMatch = sourceUrl.match(/arxiv\.org\/(?:abs|pdf)\/([^?#/]+)/i);
    return Response.json({
      source: "Jina Reader",
      title: result.title || new URL(sourceUrl).hostname,
      abstract: result.description || content.slice(0, 1200),
      url: result.url || sourceUrl,
      pdfUrl: sourceUrl.toLowerCase().includes(".pdf") ? sourceUrl : null,
      arxivId: arxivMatch?.[1]?.replace(/\.pdf$/i, "") ?? null,
      readerContent: content.slice(0, 14000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "URL import failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
