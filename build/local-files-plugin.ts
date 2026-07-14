import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const configuredImportDirectory = process.env.PA_LEGACY_IMPORT_DIR?.trim();
const legacyFileDirectory = configuredImportDirectory?.startsWith("~/")
  ? resolve(homedir(), configuredImportDirectory.slice(2))
  : resolve(configuredImportDirectory || join(homedir(), ".papercli"));
const paDataDirectory = resolve(process.cwd(), "data");

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}

async function readFileBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > maxBytes) {
    throw new Error(`The selected file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error(`The selected file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
    }
    chunks.push(buffer);
  }
  if (!total) {
    throw new Error("The selected file is empty.");
  }
  return Buffer.concat(chunks);
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

function localFilePath(kind: "pdfs" | "html", name: string): string {
  const folder = kind === "pdfs" ? "pdfs" : "html_snapshots";
  const paPath = join(paDataDirectory, folder, name);
  return existsSync(paPath) ? paPath : join(legacyFileDirectory, folder, name);
}

function serveFile(request: IncomingMessage, response: ServerResponse, filePath: string, contentType: string): void {
  if (!existsSync(filePath)) {
    sendJson(response, { error: "The local PA file was not found." }, 404);
    return;
  }
  const stat = statSync(filePath);
  const range = request.headers.range;
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "private, max-age=60");
  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      response.setHeader("Content-Length", end - start + 1);
      createReadStream(filePath, { start, end }).pipe(response);
      return;
    }
  }
  response.setHeader("Content-Length", stat.size);
  createReadStream(filePath).pipe(response);
}

function serveHtmlSnapshot(response: ServerResponse, filePath: string): void {
  if (!existsSync(filePath)) {
    sendJson(response, { error: "The local PA HTML snapshot was not found." }, 404);
    return;
  }
  const readerStyles = `<style id="paper-assistant-reader-style">
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
  let html = readFileSync(filePath, "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*>/gi, "");
  html = html.includes("</head>")
    ? html.replace("</head>", `${readerStyles}</head>`)
    : `${readerStyles}${html}`;
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "private, max-age=60");
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; frame-ancestors 'self'");
  response.setHeader("Content-Length", Buffer.byteLength(html));
  response.end(html);
}

export function paLocalFiles(): Plugin {
  return {
    name: "pa-local-files",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname === "/api/local-file-import") {
          if (request.method !== "POST") {
            sendJson(response, { error: "Use POST to load a local file." }, 405);
            return;
          }
          try {
            const kind = request.headers["x-pa-file-kind"];
            if (kind !== "pdf" && kind !== "html") {
              throw new Error("Choose whether this is a PDF or HTML snapshot.");
            }
            const encodedName = request.headers["x-pa-file-name"];
            const originalName = decodeURIComponent(Array.isArray(encodedName) ? encodedName[0] : encodedName ?? "");
            const targetDirectory = join(paDataDirectory, kind === "pdf" ? "pdfs" : "html_snapshots");
            const allowedExtensions = kind === "pdf" ? new Set([".pdf"]) : new Set([".html", ".htm"]);
            const maxBytes = kind === "pdf" ? 150 * 1024 * 1024 : 20 * 1024 * 1024;
            mkdirSync(targetDirectory, { recursive: true });
            const storedPath = safeStoredName(originalName, targetDirectory, allowedExtensions);
            const contents = await readFileBody(request, maxBytes);
            if (kind === "pdf" && !contents.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
              throw new Error("The selected file does not appear to be a valid PDF.");
            }
            writeFileSync(join(targetDirectory, storedPath), contents, { flag: "wx" });
            sendJson(response, {
              storedPath,
              fileUrl: `/pa-files/${kind === "pdf" ? "pdfs" : "html"}/${encodeURIComponent(storedPath)}`,
            });
          } catch (error) {
            sendJson(response, { error: error instanceof Error ? error.message : "The local file could not be loaded." }, 400);
          }
          return;
        }
        if (url.pathname.startsWith("/pa-files/")) {
          const parts = url.pathname.split("/");
          const kind = parts[2];
          const requestedName = decodeURIComponent(parts.slice(3).join("/"));
          if (!requestedName || basename(requestedName) !== requestedName || (kind !== "pdfs" && kind !== "html")) {
            sendJson(response, { error: "Invalid local file path." }, 400);
            return;
          }
          const filePath = localFilePath(kind, requestedName);
          if (kind === "pdfs") {
            serveFile(request, response, filePath, "application/pdf");
          } else {
            serveHtmlSnapshot(response, filePath);
          }
          return;
        }
        next();
      });
    },
  };
}
