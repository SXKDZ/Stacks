import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { databasePath, libraryRoot } from "@/db/library-paths";
import { safeFetch } from "@/app/lib/url-safety";

/**
 * Local filesystem companion for PA's self-contained library folder. All PDF
 * and HTML snapshot assets live under `libraryRoot()/pdfs` and
 * `libraryRoot()/html_snapshots`; nothing is read from the legacy `.papercli`
 * or `.wrangler` locations.
 */

export const PDF_LIMIT = 150 * 1024 * 1024;
export const HTML_LIMIT = 20 * 1024 * 1024;

export type AcquisitionKind = "pdf" | "html";

export interface SourceAcquisitionRequest {
  operation?: "check" | "acquire";
  preferred?: "auto" | AcquisitionKind;
  sourceUrl?: string;
  pdfUrl?: string;
  title?: string;
  preprintId?: string;
  localPath?: string;
  htmlSnapshotPath?: string;
}

export interface RevealLocalFileRequest {
  kind?: AcquisitionKind;
  path?: string;
}

export function storedDirectory(kind: AcquisitionKind): string {
  return join(libraryRoot(), kind === "pdf" ? "pdfs" : "html_snapshots");
}

export function storedFileExists(kind: AcquisitionKind, name: string | null): boolean {
  if (!name) {
    return false;
  }
  return existsSync(join(storedDirectory(kind), name));
}

/**
 * Delete a PA-managed asset by its stored (portable) filename. Only removes
 * files inside the managed pdfs/ or html_snapshots/ directory — a value that
 * isn't a bare filename (e.g. contains a path separator) is ignored, so this
 * can never reach outside the library folder. Returns true if a file was removed.
 */
export function removeStoredFile(kind: AcquisitionKind, name: string | null | undefined): boolean {
  const trimmed = name?.trim();
  if (!trimmed || basename(trimmed) !== trimmed || trimmed === "." || trimmed === "..") {
    return false;
  }
  const target = join(storedDirectory(kind), trimmed);
  try {
    if (existsSync(target)) {
      unlinkSync(target);
      return true;
    }
  } catch {
    // A file that vanished or can't be removed must not abort the delete.
  }
  return false;
}

interface AssetInspection {
  storedFiles: number;
  storedBytes: number;
  present: number;
  missing: number;
  missingPaths: string[];
  orphanedNames: string[];
  orphanedBytes: number;
}

function inspectAssets(kind: AcquisitionKind, referenced: string[]): AssetInspection {
  const directory = storedDirectory(kind);
  const referencedSet = new Set(referenced.filter(Boolean));
  let storedFiles = 0;
  let storedBytes = 0;
  let orphanedBytes = 0;
  const onDisk = new Set<string>();
  const orphanedNames: string[] = [];
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      onDisk.add(entry.name);
      const bytes = statSync(join(directory, entry.name)).size;
      storedFiles += 1;
      storedBytes += bytes;
      if (!referencedSet.has(entry.name)) {
        orphanedNames.push(entry.name);
        orphanedBytes += bytes;
      }
    }
  }
  const missingPaths = [...referencedSet].filter((name) => !onDisk.has(name));
  return {
    storedFiles,
    storedBytes,
    present: referencedSet.size - missingPaths.length,
    missing: missingPaths.length,
    missingPaths,
    orphanedNames,
    orphanedBytes,
  };
}

/**
 * Inspect the on-disk PDF/HTML assets in the library folder against the paths
 * referenced by the database. When `clean` is set, delete only orphaned
 * (unreferenced) files. Returns the counts/sizes the settings Doctor UI reads.
 */
export function inspectStorage(
  referencedPdfNames: string[],
  referencedHtmlNames: string[],
  clean = false,
) {
  const pdf = inspectAssets("pdf", referencedPdfNames);
  const html = inspectAssets("html", referencedHtmlNames);
  let removedFiles = 0;
  let removedBytes = 0;
  if (clean) {
    for (const [kind, names] of [["pdf", pdf.orphanedNames], ["html", html.orphanedNames]] as const) {
      for (const name of names) {
        try {
          const path = join(storedDirectory(kind), name);
          removedBytes += statSync(path).size;
          unlinkSync(path);
          removedFiles += 1;
        } catch {
          // Skip files that vanished or can't be removed.
        }
      }
    }
  }
  return {
    libraryRoot: libraryRoot(),
    databaseExists: existsSync(databasePath()),
    pdf,
    html,
    orphanedFiles: pdf.orphanedNames.length + html.orphanedNames.length,
    orphanedBytes: pdf.orphanedBytes + html.orphanedBytes,
    totalFiles: pdf.storedFiles + html.storedFiles,
    totalBytes: pdf.storedBytes + html.storedBytes,
    removedFiles,
    removedBytes,
  };
}

export function portableStoredName(value: string | undefined, kind: AcquisitionKind): string | null {
  const name = value?.trim();
  if (!name) {
    return null;
  }
  if (basename(name) !== name || name === "." || name === "..") {
    throw new Error("Local file paths must be portable filenames without folders.");
  }
  const extension = extname(name).toLowerCase();
  const allowed = kind === "pdf" ? new Set([".pdf"]) : new Set([".html", ".htm"]);
  if (!allowed.has(extension)) {
    throw new Error(kind === "pdf" ? "The local PDF path must end in .pdf." : "The local HTML path must end in .html or .htm.");
  }
  return name;
}

function safeStoredName(originalName: string, targetDirectory: string, allowedExtensions: Set<string>): string {
  const extension = extname(originalName).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new Error(`Choose a ${[...allowedExtensions].join(" or ")} file.`);
  }
  const rawStem = basename(originalName, extension);
  const stem = rawStem.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+|\.+$/g, "") || "paper";
  let candidate = `${stem}${extension}`;
  let copy = 2;
  while (existsSync(join(targetDirectory, candidate))) {
    candidate = `${stem}-${copy}${extension}`;
    copy += 1;
  }
  return candidate;
}

async function readRequestBytes(request: Request, maxBytes: number): Promise<Buffer> {
  const tooLarge = () =>
    new Error(`The selected file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) {
    throw tooLarge();
  }
  // Stream and cap incrementally: a missing or dishonest Content-Length must not
  // let an oversized (or unbounded) body be buffered into memory.
  if (!request.body) {
    throw new Error("The selected file is empty.");
  }
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!received) {
    throw new Error("The selected file is empty.");
  }
  return Buffer.concat(chunks, received);
}

export async function importLocalFile(request: Request): Promise<{ storedPath: string; fileUrl: string }> {
  const kind = request.headers.get("x-pa-file-kind");
  if (kind !== "pdf" && kind !== "html") {
    throw new Error("Choose whether this is a PDF or HTML snapshot.");
  }
  const originalName = decodeURIComponent(request.headers.get("x-pa-file-name") ?? "");
  const targetDirectory = join(libraryRoot(), kind === "pdf" ? "pdfs" : "html_snapshots");
  const allowedExtensions = kind === "pdf" ? new Set([".pdf"]) : new Set([".html", ".htm"]);
  const maxBytes = kind === "pdf" ? PDF_LIMIT : HTML_LIMIT;
  mkdirSync(targetDirectory, { recursive: true });
  const storedPath = safeStoredName(originalName, targetDirectory, allowedExtensions);
  const contents = await readRequestBytes(request, maxBytes);
  if (kind === "pdf" && !contents.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("The selected file does not appear to be a valid PDF.");
  }
  writeFileSync(join(targetDirectory, storedPath), contents, { flag: "wx" });
  return {
    storedPath,
    fileUrl: `/pa-files/${kind === "pdf" ? "pdfs" : "html"}/${encodeURIComponent(storedPath)}`,
  };
}

function validatedHttpUrl(value: string | undefined): URL | null {
  const candidate = value?.trim();
  if (!candidate) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Source URLs must be complete http:// or https:// URLs.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Source URLs must use http:// or https://.");
  }
  return url;
}

function arxivPdfUrl(source: URL | null, preprintId: string | undefined): URL | null {
  const explicitId = preprintId?.trim().replace(/^arxiv:\s*/i, "").replace(/v\d+$/i, "");
  if (explicitId && /^(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})$/i.test(explicitId)) {
    return new URL(`https://arxiv.org/pdf/${explicitId}.pdf`);
  }
  if (!source || !/(^|\.)arxiv\.org$/i.test(source.hostname)) {
    return null;
  }
  const match = source.pathname.match(/^\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?$/i);
  return match ? new URL(`https://arxiv.org/pdf/${match[1]}.pdf`) : null;
}

function openReviewPdfUrl(source: URL | null): URL | null {
  if (!source || !/(^|\.)openreview\.net$/i.test(source.hostname)) {
    return null;
  }
  const id = source.searchParams.get("id");
  return id ? new URL(`https://openreview.net/pdf?id=${encodeURIComponent(id)}`) : null;
}

function candidatePdfUrls(payload: SourceAcquisitionRequest): URL[] {
  const source = validatedHttpUrl(payload.sourceUrl);
  const explicitPdf = validatedHttpUrl(payload.pdfUrl);
  const candidates = [explicitPdf];
  if (source && (source.pathname.toLowerCase().endsWith(".pdf") || source.searchParams.get("download")?.toLowerCase() === "pdf")) {
    candidates.push(source);
  }
  candidates.push(arxivPdfUrl(source, payload.preprintId), openReviewPdfUrl(source));
  const seen = new Set<string>();
  return candidates.filter((candidate): candidate is URL => Boolean(candidate)).filter((candidate) => {
    if (seen.has(candidate.href)) {
      return false;
    }
    seen.add(candidate.href);
    return true;
  });
}

async function fetchWithLimit(
  url: URL,
  maxBytes: number,
  extraHeaders: Record<string, string> = {},
): Promise<{ contents: Buffer; contentType: string }> {
  // safeFetch enforces https-only + private-address blocking + per-hop redirect
  // revalidation, so a user-supplied source URL cannot be used to reach internal
  // or cloud-metadata endpoints (SSRF).
  const response = await safeFetch(url, { headers: extraHeaders });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) {
    throw new Error("The remote file exceeds PA’s storage limit.");
  }
  if (!response.body) {
    throw new Error("The remote source returned an empty response.");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error("The remote file exceeds PA’s storage limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const contents = Buffer.concat(chunks, received);
  if (!contents.length) {
    throw new Error("The remote source returned an empty file.");
  }
  return { contents, contentType: response.headers.get("content-type") ?? "" };
}

function acquisitionFilename(title: string | undefined, source: URL, extension: ".pdf" | ".html"): string {
  const stem = (title?.trim() || basename(source.pathname, extname(source.pathname)) || "paper")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .toLowerCase() || "paper";
  const digest = createHash("sha256").update(source.href).digest("hex").slice(0, 10);
  return `${stem}-${digest}${extension}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] ?? character);
}

interface AcquisitionResult {
  kind: AcquisitionKind;
  storedPath: string;
  fileUrl: string;
  sourceUrl: string;
}

async function acquirePdf(payload: SourceAcquisitionRequest): Promise<AcquisitionResult> {
  const candidates = candidatePdfUrls(payload);
  if (!candidates.length) {
    throw new Error("No downloadable PDF URL could be derived from this record.");
  }
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const { contents, contentType } = await fetchWithLimit(candidate, PDF_LIMIT);
      if (!contents.subarray(0, 5).equals(Buffer.from("%PDF-")) && !contentType.toLowerCase().includes("application/pdf")) {
        throw new Error("the response is not a PDF");
      }
      if (!contents.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        throw new Error("the response does not contain a valid PDF signature");
      }
      const directory = join(libraryRoot(), "pdfs");
      mkdirSync(directory, { recursive: true });
      const storedPath = acquisitionFilename(payload.title, candidate, ".pdf");
      const target = join(directory, storedPath);
      if (!existsSync(target)) {
        writeFileSync(target, contents, { flag: "wx" });
      }
      return { kind: "pdf", storedPath, fileUrl: `/pa-files/pdfs/${encodeURIComponent(storedPath)}`, sourceUrl: candidate.href };
    } catch (error) {
      failures.push(`${candidate.hostname}: ${error instanceof Error ? error.message : "download failed"}`);
    }
  }
  throw new Error(`PDF download failed (${failures.join("; ")}).`);
}

async function acquireHtml(payload: SourceAcquisitionRequest): Promise<AcquisitionResult> {
  const source = validatedHttpUrl(payload.sourceUrl);
  if (!source) {
    throw new Error("A Source URL is required to save an HTML snapshot.");
  }
  let contents: Buffer;
  let contentType = "";
  try {
    ({ contents, contentType } = await fetchWithLimit(source, HTML_LIMIT));
  } catch (directError) {
    if (!process.env.JINA_API_KEY?.trim()) {
      throw directError;
    }
    const jinaUrl = new URL(`https://r.jina.ai/${source.href}`);
    ({ contents, contentType } = await fetchWithLimit(jinaUrl, HTML_LIMIT, {
      Authorization: `Bearer ${process.env.JINA_API_KEY?.trim()}`,
    }));
  }
  if (!/html|xml|text\/plain|markdown/i.test(contentType) && /\0/.test(contents.toString("utf8", 0, Math.min(contents.length, 4096)))) {
    throw new Error("The source did not return readable HTML or text.");
  }
  let html = contents.toString("utf8");
  if (!/<(?:!doctype|html|body|article|main)\b/i.test(html)) {
    html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(payload.title?.trim() || source.hostname)}</title></head><body><main><pre style="white-space:pre-wrap">${escapeHtml(html)}</pre></main></body></html>`;
  }
  const directory = join(libraryRoot(), "html_snapshots");
  mkdirSync(directory, { recursive: true });
  const storedPath = acquisitionFilename(payload.title, source, ".html");
  const target = join(directory, storedPath);
  if (!existsSync(target)) {
    writeFileSync(target, html, { flag: "wx" });
  }
  return { kind: "html", storedPath, fileUrl: `/pa-files/html/${encodeURIComponent(storedPath)}`, sourceUrl: source.href };
}

export async function acquireSource(payload: SourceAcquisitionRequest): Promise<unknown> {
  const localPath = portableStoredName(payload.localPath, "pdf");
  const htmlSnapshotPath = portableStoredName(payload.htmlSnapshotPath, "html");
  if ((payload.operation ?? "check") === "check") {
    return {
      localPath,
      htmlSnapshotPath,
      pdfExists: storedFileExists("pdf", localPath),
      htmlExists: storedFileExists("html", htmlSnapshotPath),
    };
  }
  const preferred = payload.preferred ?? "auto";
  if (preferred === "pdf") {
    return acquirePdf(payload);
  }
  if (preferred === "html") {
    return acquireHtml(payload);
  }
  try {
    return await acquirePdf(payload);
  } catch (pdfError) {
    try {
      return await acquireHtml(payload);
    } catch (htmlError) {
      throw new Error(`${pdfError instanceof Error ? pdfError.message : "PDF download failed"} ${htmlError instanceof Error ? htmlError.message : "HTML snapshot failed"}`);
    }
  }
}

export function revealLocalFile(kind: AcquisitionKind, name: string): void {
  const target = join(storedDirectory(kind), name);
  if (!existsSync(target)) {
    throw new Error("The stored PA file no longer exists.");
  }
  if (process.platform === "darwin") {
    spawn("open", ["-R", target], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "win32") {
    spawn("explorer.exe", ["/select,", target], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [dirname(target)], { detached: true, stdio: "ignore" }).unref();
}

/** Resolve a `/pa-files/<pdfs|html>/<name>` request to a validated absolute path. */
export function resolveStoredFile(kind: string, requestedName: string): { path: string; kind: AcquisitionKind } | null {
  if (!requestedName || basename(requestedName) !== requestedName || (kind !== "pdfs" && kind !== "html")) {
    return null;
  }
  const assetKind: AcquisitionKind = kind === "pdfs" ? "pdf" : "html";
  const directory = storedDirectory(assetKind);
  const filePath = join(directory, requestedName);
  if (resolve(filePath) !== filePath || !resolve(filePath).startsWith(resolve(directory) + sep)) {
    return null;
  }
  return { path: filePath, kind: assetKind };
}

export async function servePdfFile(filePath: string, rangeHeader: string | null): Promise<Response> {
  if (!existsSync(filePath)) {
    return Response.json({ error: "The local PA file was not found." }, { status: 404 });
  }
  const fileStat = statSync(filePath);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": "application/pdf",
    "Cache-Control": "private, max-age=60",
  });
  if (rangeHeader) {
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    if (match && (match[1] || match[2])) {
      const size = fileStat.size;
      // Support `start-`, `start-end`, and suffix `-lastN` forms; clamp to the
      // file bounds and reject anything unsatisfiable with a 416 so a crafted
      // header can never produce a negative Content-Length or an invalid read.
      let start: number;
      let end: number;
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
      } else {
        const suffixLength = Number(match[2]);
        start = Math.max(0, size - suffixLength);
        end = size - 1;
      }
      end = Math.min(end, size - 1);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size || size === 0) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
      headers.set("Content-Length", String(end - start + 1));
      const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as unknown as ReadableStream<Uint8Array>;
      return new Response(stream, { status: 206, headers });
    }
  }
  headers.set("Content-Length", String(fileStat.size));
  const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, { status: 200, headers });
}

const READER_STYLES = `<style id="paper-assistant-reader-style">
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html { background: #f4f1f5; }
    body { background: white; color: #28222d; font-family: Georgia, "Times New Roman", serif; font-size: 17px; line-height: 1.72; margin: 24px auto; max-width: 900px; min-height: calc(100vh - 48px); padding: clamp(28px, 7vw, 82px); }
    article, main { margin-inline: auto; max-width: 720px; }
    h1, h2, h3, h4 { color: #211b27; font-family: ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.025em; line-height: 1.18; }
    h1 { font-size: clamp(2rem, 5vw, 3.7rem); margin-top: 0; }
    h2 { margin-top: 2.2em; }
    p, li { max-width: 72ch; }
    a { color: #6950b7; text-underline-offset: 3px; }
    img, video, figure, pre, table { height: auto; max-width: 100%; }
    blockquote { border-left: 3px solid #b8a8e8; color: #62596a; margin-left: 0; padding-left: 1.2em; }
    code, pre { background: #f3f0f5; border-radius: 5px; }
    code { font-size: .88em; padding: .12em .3em; }
    pre { overflow-x: auto; padding: 1em; }
    nav, header button, footer { display: none !important; }
    @media (max-width: 700px) { body { margin: 0; padding: 25px 19px 50px; } }
  </style>`;

export function serveHtmlSnapshot(filePath: string): Response {
  if (!existsSync(filePath)) {
    return Response.json({ error: "The local PA HTML snapshot was not found." }, { status: 404 });
  }
  let html = readFileSync(filePath, "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*>/gi, "");
  html = html.includes("</head>")
    ? html.replace("</head>", `${READER_STYLES}</head>`)
    : `${READER_STYLES}${html}`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, max-age=60",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; frame-ancestors 'self'",
      "Content-Length": String(Buffer.byteLength(html)),
    },
  });
}
