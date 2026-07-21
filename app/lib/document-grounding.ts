import { getDocumentProxy } from "unpdf";
import { privateHostname, publicHttpsUrl } from "@/app/lib/url-safety";

const MAX_DOCUMENT_BYTES = 35 * 1024 * 1024;
const MAX_PAPER_CHARACTERS = 20_000;
const CACHE_TTL = 10 * 60 * 1000;

interface CacheEntry {
  expiresAt: number;
  text: string;
}

const contextCache = new Map<string, CacheEntry>();

function documentUrl(value: string | null | undefined, requestUrl: string, kind: "pdf" | "html"): URL | null {
  const candidate = value?.trim();
  if (!candidate) {
    return null;
  }
  const base = new URL(requestUrl);
  let url: URL;
  try {
    url = new URL(candidate, base);
  } catch {
    return null;
  }
  if (url.origin === base.origin) {
    const expectedPrefix = kind === "pdf" ? "/stacks-files/pdfs/" : "/stacks-files/html/";
    return url.pathname.startsWith(expectedPrefix) ? url : null;
  }
  if (!publicHttpsUrl(url)) {
    return null;
  }
  return url;
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_DOCUMENT_BYTES) {
    throw new Error("The attached document is too large for chat grounding.");
  }
  if (!response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new Error("The attached document is too large for chat grounding.");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function fetchDocumentBytes(url: URL): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    let current = url;
    const localDocument = privateHostname(url.hostname);
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      const response = await fetch(current, {
        headers: { Accept: "application/pdf,text/html;q=0.9,*/*;q=0.5" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || localDocument || redirectCount === 3) {
          throw new Error("The attached document returned an unsafe redirect.");
        }
        const next = new URL(location, current);
        if (!publicHttpsUrl(next)) {
          throw new Error("The attached document redirected to a private or insecure address.");
        }
        current = next;
        continue;
      }
      if (!response.ok) {
        throw new Error(`Attached document returned ${response.status}.`);
      }
      return await responseBytes(response);
    }
    throw new Error("The attached document redirected too many times.");
  } finally {
    clearTimeout(timeout);
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function pdfText(url: URL, startPage: number, endPage: number): Promise<string> {
  const bytes = await fetchDocumentBytes(url);
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error("The attached PDF URL did not return a PDF.");
  }
  const document = await getDocumentProxy(bytes);
  try {
    const first = Math.min(document.numPages, Math.max(1, startPage));
    const last = Math.min(document.numPages, Math.max(first, endPage));
    const pages: string[] = [];
    for (let pageNumber = first; pageNumber <= last; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => "str" in item ? item.str : "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        pages.push(`Page ${pageNumber}:\n${text}`);
      }
      page.cleanup();
      if (pages.join("\n\n").length >= MAX_PAPER_CHARACTERS) {
        break;
      }
    }
    return pages.join("\n\n").slice(0, MAX_PAPER_CHARACTERS);
  } finally {
    await document.destroy().catch(() => undefined);
  }
}

async function htmlText(url: URL): Promise<string> {
  const bytes = await fetchDocumentBytes(url);
  return decodeHtml(new TextDecoder().decode(bytes)).slice(0, MAX_PAPER_CHARACTERS);
}

async function cachedText(key: string, loader: () => Promise<string>): Promise<string> {
  const cached = contextCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.text;
  }
  const text = await loader();
  if (contextCache.size >= 24) {
    contextCache.delete(contextCache.keys().next().value ?? "");
  }
  contextCache.set(key, { expiresAt: Date.now() + CACHE_TTL, text });
  return text;
}

export async function groundedDocumentText(input: {
  requestUrl: string;
  pdfUrl?: string | null;
  htmlUrl?: string | null;
  startPage?: number;
  endPage?: number;
}): Promise<{ text: string; label: string } | null> {
  const startPage = Math.max(1, Math.floor(input.startPage ?? 1));
  const endPage = Math.min(20, Math.max(startPage, Math.floor(input.endPage ?? startPage)));
  const html = documentUrl(input.htmlUrl, input.requestUrl, "html");
  if (html) {
    const text = await cachedText(`html:${html}`, () => htmlText(html));
    return text ? { text, label: "Attached webpage content" } : null;
  }
  const pdf = documentUrl(input.pdfUrl, input.requestUrl, "pdf");
  if (!pdf) {
    return null;
  }
  const text = await cachedText(`pdf:${pdf}:${startPage}-${endPage}`, () => pdfText(pdf, startPage, endPage));
  const label = startPage === endPage ? `Attached PDF page ${startPage}` : `Attached PDF pages ${startPage}-${endPage}`;
  return text ? { text, label } : null;
}
