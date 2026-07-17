import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const configuredImportDirectory = process.env.PA_LEGACY_IMPORT_DIR?.trim();
const legacyFileDirectory = configuredImportDirectory?.startsWith("~/")
  ? resolve(homedir(), configuredImportDirectory.slice(2))
  : resolve(configuredImportDirectory || join(homedir(), ".papercli"));
const repositoryDataDirectory = resolve(process.cwd(), "data");
const storageConfigDirectory = join(homedir(), ".paperassistant");
const storageConfigPath = join(storageConfigDirectory, "storage.json");
const defaultLibraryDirectory = repositoryDataDirectory;
const localD1Directory = join(
  process.cwd(),
  ".wrangler",
  "state",
  "v3",
  "d1",
  "miniflare-D1DatabaseObject",
);

function expandLibraryPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Choose a library folder.");
  }
  return trimmed.startsWith("~/") ? resolve(homedir(), trimmed.slice(2)) : resolve(trimmed);
}

function configuredLibraryDirectory(): string {
  if (process.env.PA_LIBRARY_DIR?.trim()) {
    return expandLibraryPath(process.env.PA_LIBRARY_DIR);
  }
  if (existsSync(storageConfigPath)) {
    try {
      const stored = JSON.parse(readFileSync(storageConfigPath, "utf8")) as { libraryRoot?: string };
      if (stored.libraryRoot?.trim()) {
        return expandLibraryPath(stored.libraryRoot);
      }
    } catch {
      // A malformed optional preference must not prevent PA from starting.
    }
  }
  return defaultLibraryDirectory;
}

let activeLibraryDirectory = configuredLibraryDirectory();

function libraryDataDirectory(): string {
  return activeLibraryDirectory;
}

function ensureLibraryDirectory(directory = libraryDataDirectory()): void {
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(directory, "pdfs"), { recursive: true });
  mkdirSync(join(directory, "html_snapshots"), { recursive: true });
}

function persistLibraryDirectory(directory: string): void {
  mkdirSync(storageConfigDirectory, { recursive: true });
  writeFileSync(storageConfigPath, `${JSON.stringify({ libraryRoot: directory }, null, 2)}\n`, {
    mode: 0o600,
  });
}

function copyMissingDirectoryContents(sourceDirectory: string, targetDirectory: string): void {
  mkdirSync(targetDirectory, { recursive: true });
  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    const source = join(sourceDirectory, entry.name);
    const target = join(targetDirectory, entry.name);
    if (entry.isDirectory()) {
      copyMissingDirectoryContents(source, target);
      continue;
    }
    if (!existsSync(target)) {
      cpSync(source, target, { errorOnExist: true, force: false });
    }
  }
}

function bootstrapLibraryDirectory(): void {
  ensureLibraryDirectory();
  if (repositoryDataDirectory !== libraryDataDirectory() && existsSync(repositoryDataDirectory)) {
    copyMissingDirectoryContents(repositoryDataDirectory, libraryDataDirectory());
  }
  persistLibraryDirectory(libraryDataDirectory());
}
const PDF_LIMIT = 150 * 1024 * 1024;
const HTML_LIMIT = 20 * 1024 * 1024;

type AcquisitionKind = "pdf" | "html";

interface SourceAcquisitionRequest {
  operation?: "check" | "acquire";
  preferred?: "auto" | AcquisitionKind;
  sourceUrl?: string;
  pdfUrl?: string;
  title?: string;
  preprintId?: string;
  localPath?: string;
  htmlSnapshotPath?: string;
}

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

async function readJsonBody<T extends object>(request: IncomingMessage): Promise<T> {
  const contents = await readFileBody(request, 256 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error("The acquisition request is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The acquisition request must be an object.");
  }
  return value as T;
}

interface StorageManagementRequest {
  operation?: "inspect" | "clean" | "repair" | "move";
  targetDirectory?: string;
  confirmed?: boolean;
  pdfPaths?: string[];
  htmlPaths?: string[];
  papers?: Array<{
    id?: string;
    localPath?: string | null;
    htmlSnapshotPath?: string | null;
  }>;
}

interface RevealLocalFileRequest {
  kind?: AcquisitionKind;
  path?: string;
}

function storedDirectory(kind: AcquisitionKind): string {
  return join(libraryDataDirectory(), kind === "pdf" ? "pdfs" : "html_snapshots");
}

function managedStoredFileExists(kind: AcquisitionKind, name: string | null): boolean {
  return Boolean(name && existsSync(join(storedDirectory(kind), name)));
}

function scanStoredAssets(kind: AcquisitionKind, referenced: Set<string>) {
  const directory = storedDirectory(kind);
  mkdirSync(directory, { recursive: true });
  const allowed = kind === "pdf" ? new Set([".pdf"]) : new Set([".html", ".htm"]);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && allowed.has(extname(entry.name).toLowerCase()))
    .map((entry) => {
      const path = join(directory, entry.name);
      const stat = statSync(path);
      return {
        kind,
        name: entry.name,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        modifiedMs: stat.mtimeMs,
        orphaned: !referenced.has(entry.name),
      };
    });
}

function findLocalD1Database(): string | null {
  if (!existsSync(localD1Directory)) {
    return null;
  }
  return readdirSync(localD1Directory)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => join(localD1Directory, name))
    .filter((path) => existsSync(path))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] ?? null;
}

interface LocalPaperRow {
  id: string;
  title: string;
  year: number | null;
  local_path: string | null;
  html_snapshot_path: string | null;
  first_author: string | null;
}

function countValue(database: DatabaseSync, query: string): number {
  const row = database.prepare(query).get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function absoluteStoredPath(value: string | null): boolean {
  return Boolean(value && isAbsolute(value));
}

function conventionalPdfName(paper: LocalPaperRow, source: string): string {
  const author = (paper.first_author ?? "unknown").trim().split(/\s+/).at(-1)?.toLowerCase() || "unknown";
  const authorLastName = author.normalize("NFKD").replace(/[^a-z0-9_]/g, "") || "unknown";
  const commonWords = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was", "one", "our", "out",
    "day", "get", "has", "him", "his", "how", "its", "may", "new", "now", "old", "see", "two", "who", "boy", "did",
    "man", "run", "say", "she", "too", "use",
  ]);
  const firstWord = paper.title.toLowerCase().match(/[a-z]+/g)?.find((word) => word.length > 3 && !commonWords.has(word)) ?? "untitled";
  const hash = createHash("md5").update(readFileSync(source).subarray(0, 8192)).digest("hex").slice(0, 6);
  return `${authorLastName}${paper.year ?? "nodate"}${firstWord}_${hash}.pdf`.replace(/[^\w.-]/g, "");
}

function localDatabaseDiagnostic(repair: boolean) {
  const databasePath = findLocalD1Database();
  if (!databasePath) {
    return null;
  }
  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  const renamed: Array<{ from: string; to: string }> = [];
  const repairSummary = {
    orphanedAssociations: 0,
    portablePaths: 0,
    renamedPdfs: 0,
    skippedRepairs: 0,
    migratedLegacyFiles: 0,
  };
  try {
    database.exec("PRAGMA foreign_keys = ON");
    if (repair) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const associationQueries = [
          `DELETE FROM paper_authors WHERE paper_id NOT IN (SELECT id FROM papers) OR author_id NOT IN (SELECT id FROM authors)`,
          `DELETE FROM paper_collections WHERE paper_id NOT IN (SELECT id FROM papers) OR collection_id NOT IN (SELECT id FROM collections)`,
          `DELETE FROM paper_tags WHERE paper_id NOT IN (SELECT id FROM papers) OR tag_id NOT IN (SELECT id FROM tags)`,
        ];
        for (const query of associationQueries) {
          repairSummary.orphanedAssociations += Number(database.prepare(query).run().changes);
        }

        const paperRows = database.prepare(`SELECT p.id, p.title, p.year, p.local_path, p.html_snapshot_path,
          (SELECT a.display_name FROM paper_authors pa JOIN authors a ON a.id = pa.author_id
            WHERE pa.paper_id = p.id ORDER BY pa.author_order LIMIT 1) AS first_author
          FROM papers p`).all() as unknown as LocalPaperRow[];
        const pathUpdate = database.prepare("UPDATE papers SET local_path = ?, html_snapshot_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
        const pdfUpdate = database.prepare("UPDATE papers SET local_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
        const pathCounts = new Map<string, number>();
        for (const paper of paperRows) {
          if (paper.local_path) {
            pathCounts.set(paper.local_path, (pathCounts.get(paper.local_path) ?? 0) + 1);
          }
        }
        for (const paper of paperRows) {
          let pdfPath = paper.local_path;
          let htmlPath = paper.html_snapshot_path;
          if (absoluteStoredPath(pdfPath)) {
            const portable = relative(storedDirectory("pdf"), pdfPath as string);
            if (basename(portable) === portable && managedStoredFileExists("pdf", portable)) {
              pdfPath = portable;
              repairSummary.portablePaths += 1;
            } else {
              repairSummary.skippedRepairs += 1;
            }
          }
          if (absoluteStoredPath(htmlPath)) {
            const portable = relative(storedDirectory("html"), htmlPath as string);
            if (basename(portable) === portable && managedStoredFileExists("html", portable)) {
              htmlPath = portable;
              repairSummary.portablePaths += 1;
            } else {
              repairSummary.skippedRepairs += 1;
            }
          }
          if (pdfPath !== paper.local_path || htmlPath !== paper.html_snapshot_path) {
            pathUpdate.run(pdfPath, htmlPath, paper.id);
          }
          if (!pdfPath || isAbsolute(pdfPath) || (pathCounts.get(paper.local_path ?? "") ?? 0) > 1) {
            continue;
          }
          const oldPath = join(storedDirectory("pdf"), pdfPath);
          if (!existsSync(oldPath)) {
            continue;
          }
          const newName = conventionalPdfName({ ...paper, local_path: pdfPath }, oldPath);
          const newPath = join(storedDirectory("pdf"), newName);
          if (newName === pdfPath) {
            continue;
          }
          if (existsSync(newPath)) {
            repairSummary.skippedRepairs += 1;
            continue;
          }
          renameSync(oldPath, newPath);
          renamed.push({ from: oldPath, to: newPath });
          pdfUpdate.run(newName, paper.id);
          repairSummary.renamedPdfs += 1;
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        for (const entry of renamed.reverse()) {
          if (existsSync(entry.to) && !existsSync(entry.from)) {
            renameSync(entry.to, entry.from);
          }
        }
        throw error;
      }
    }

    const integrityRows = database.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all() as Array<Record<string, unknown>>;
    const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as Record<string, unknown> | undefined;
    const paperRows = database.prepare("SELECT local_path, html_snapshot_path FROM papers").all() as Array<{ local_path: string | null; html_snapshot_path: string | null }>;
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    const tableCounts: Record<string, number> = {};
    for (const { name } of tables) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        tableCounts[name] = countValue(database, `SELECT COUNT(*) AS count FROM ${name}`);
      }
    }
    const integrityMessages = integrityRows.flatMap((row) => Object.values(row).map(String));
    return {
      integrityOk: integrityMessages.length > 0 && integrityMessages.every((value) => value.toLowerCase() === "ok"),
      integrityMessages,
      foreignKeyEnforced: Object.values(foreignKeys ?? {}).some((value) => Number(value) === 1),
      foreignKeyViolations: foreignKeyRows.length,
      tableCounts,
      orphanedAssociations: {
        paperAuthors: countValue(database, `SELECT COUNT(*) AS count FROM paper_authors pa LEFT JOIN papers p ON p.id = pa.paper_id LEFT JOIN authors a ON a.id = pa.author_id WHERE p.id IS NULL OR a.id IS NULL`),
        paperCollections: countValue(database, `SELECT COUNT(*) AS count FROM paper_collections pc LEFT JOIN papers p ON p.id = pc.paper_id LEFT JOIN collections c ON c.id = pc.collection_id WHERE p.id IS NULL OR c.id IS NULL`),
        paperTags: countValue(database, `SELECT COUNT(*) AS count FROM paper_tags pt LEFT JOIN papers p ON p.id = pt.paper_id LEFT JOIN tags t ON t.id = pt.tag_id WHERE p.id IS NULL OR t.id IS NULL`),
      },
      absolutePdfPaths: paperRows.filter((paper) => absoluteStoredPath(paper.local_path)).map((paper) => paper.local_path as string),
      absoluteHtmlPaths: paperRows.filter((paper) => absoluteStoredPath(paper.html_snapshot_path)).map((paper) => paper.html_snapshot_path as string),
      repairSummary,
    };
  } finally {
    database.close();
  }
}

function localSystemHealth() {
  const disk = statfsSync(libraryDataDirectory());
  return {
    runtime: `Node ${process.version} · ${process.platform} ${process.arch}`,
    database: "SQLite (local D1)",
    filesystemAvailable: true,
    freeBytes: disk.bavail * disk.bsize,
    totalBytes: disk.blocks * disk.bsize,
    dependencies: {
      pdfExtraction: existsSync(join(process.cwd(), "node_modules", "unpdf")),
      syncBridge: existsSync(join(process.cwd(), "scripts", "pa_sync_bridge.py")),
    },
  };
}

function storageReport(payload: StorageManagementRequest, clean = false, repair = false) {
  const pdfReferences = new Set<string>();
  const htmlReferences = new Set<string>();
  const invalidPdfPaths: string[] = [];
  const invalidHtmlPaths: string[] = [];

  function addReference(value: string | null | undefined, kind: AcquisitionKind) {
    if (!value?.trim()) {
      return;
    }
    try {
      const name = portableStoredName(value, kind);
      if (name) {
        (kind === "pdf" ? pdfReferences : htmlReferences).add(name);
      }
    } catch {
      (kind === "pdf" ? invalidPdfPaths : invalidHtmlPaths).push(value);
    }
  }

  (payload.pdfPaths ?? []).forEach((value) => addReference(value, "pdf"));
  (payload.htmlPaths ?? []).forEach((value) => addReference(value, "html"));
  for (const paper of payload.papers ?? []) {
    addReference(paper.localPath, "pdf");
    addReference(paper.htmlSnapshotPath, "html");
  }
  let migratedLegacyFiles = 0;
  if (repair) {
    for (const [kind, references] of [["pdf", pdfReferences], ["html", htmlReferences]] as const) {
      for (const name of references) {
        const target = join(storedDirectory(kind), name);
        const legacy = join(legacyFileDirectory, kind === "pdf" ? "pdfs" : "html_snapshots", name);
        if (!existsSync(target) && existsSync(legacy)) {
          cpSync(legacy, target, { errorOnExist: true, force: false });
          migratedLegacyFiles += 1;
        }
      }
    }
  }
  const assets = [...scanStoredAssets("pdf", pdfReferences), ...scanStoredAssets("html", htmlReferences)];
  const orphaned = assets.filter((asset) => asset.orphaned);
  const now = Date.now();
  const removableOrphaned = orphaned.filter((asset) => {
    const recent = now - asset.modifiedMs < 120_000;
    const temporary = /(?:_temp|temp00|\.part$|\.download$)/i.test(asset.name) && now - asset.modifiedMs < 300_000;
    return !recent && !temporary;
  });
  const missingPdfPaths = [...pdfReferences].filter((name) => !managedStoredFileExists("pdf", name));
  const missingHtmlPaths = [...htmlReferences].filter((name) => !managedStoredFileExists("html", name));
  const papers = payload.papers ?? [];
  const papersWithoutLocalAsset = papers.filter((paper) => {
    let pdfName: string | null = null;
    let htmlName: string | null = null;
    try {
      pdfName = portableStoredName(paper.localPath ?? undefined, "pdf");
    } catch {
      // Invalid references are reported separately and cannot resolve to an asset.
    }
    try {
      htmlName = portableStoredName(paper.htmlSnapshotPath ?? undefined, "html");
    } catch {
      // Invalid references are reported separately and cannot resolve to an asset.
    }
    return !managedStoredFileExists("pdf", pdfName) && !managedStoredFileExists("html", htmlName);
  }).map((paper) => paper.id).filter((value): value is string => Boolean(value));
  const pdfAssets = assets.filter((asset) => asset.kind === "pdf");
  const htmlAssets = assets.filter((asset) => asset.kind === "html");
  if (clean) {
    removableOrphaned.forEach((asset) => unlinkSync(join(storedDirectory(asset.kind), asset.name)));
  }
  const databasePath = findLocalD1Database();
  const databaseHealth = localDatabaseDiagnostic(repair);
  if (databaseHealth) {
    databaseHealth.repairSummary.migratedLegacyFiles = migratedLegacyFiles;
  }
  return {
    mode: "local",
    capabilities: {
      databaseChecks: Boolean(databasePath),
      fileChecks: true,
      repairs: ["orphaned-associations", "portable-paths", "pdf-filenames"],
      folderMove: true,
    },
    libraryRoot: libraryDataDirectory(),
    libraryExists: existsSync(libraryDataDirectory()),
    databasePresent: Boolean(databasePath),
    settingsPresent: existsSync(join(libraryDataDirectory(), "settings.json")),
    assets,
    paperRecords: papers.length,
    referencedPdfFiles: pdfReferences.size,
    presentPdfFiles: pdfReferences.size - missingPdfPaths.length,
    missingPdfFiles: missingPdfPaths.length,
    missingPdfPaths,
    referencedHtmlFiles: htmlReferences.size,
    presentHtmlFiles: htmlReferences.size - missingHtmlPaths.length,
    missingHtmlFiles: missingHtmlPaths.length,
    missingHtmlPaths,
    invalidPdfPaths,
    invalidHtmlPaths,
    invalidReferences: invalidPdfPaths.length + invalidHtmlPaths.length,
    papersWithoutLocalAsset: papersWithoutLocalAsset.length,
    paperIdsWithoutLocalAsset: papersWithoutLocalAsset,
    storedPdfFiles: pdfAssets.length,
    storedPdfBytes: pdfAssets.reduce((sum, asset) => sum + asset.bytes, 0),
    storedHtmlFiles: htmlAssets.length,
    storedHtmlBytes: htmlAssets.reduce((sum, asset) => sum + asset.bytes, 0),
    totalFiles: assets.length,
    totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    orphanedFiles: orphaned.length,
    orphanedBytes: orphaned.reduce((sum, asset) => sum + asset.bytes, 0),
    protectedOrphanedFiles: orphaned.length - removableOrphaned.length,
    removedFiles: clean ? removableOrphaned.length : 0,
    removedBytes: clean ? removableOrphaned.reduce((sum, asset) => sum + asset.bytes, 0) : 0,
    databaseHealth,
    systemHealth: localSystemHealth(),
  };
}

function copyDirectoryContents(source: string, target: string): void {
  if (existsSync(target) && readdirSync(target).length) {
    throw new Error("The destination must be empty before moving the PA library.");
  }
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  }
}

function containsPath(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
}

function moveLibraryDirectory(targetValue: string | undefined, confirmed: boolean | undefined): {
  previousRoot: string;
  libraryRoot: string;
} {
  if (!confirmed) {
    throw new Error("Moving the library requires explicit confirmation.");
  }
  const source = libraryDataDirectory();
  const target = expandLibraryPath(targetValue ?? "");
  if (target === source) {
    return { previousRoot: source, libraryRoot: source };
  }
  if (containsPath(source, target) || containsPath(target, source)) {
    throw new Error("The new library folder cannot contain the current folder or be contained by it.");
  }
  ensureLibraryDirectory(source);
  copyDirectoryContents(source, target);
  persistLibraryDirectory(target);
  activeLibraryDirectory = target;
  rmSync(source, { recursive: true, force: false });
  ensureLibraryDirectory(target);
  return { previousRoot: source, libraryRoot: target };
}

function revealLocalFile(kind: AcquisitionKind, name: string): void {
  const target = localFilePath(kind === "pdf" ? "pdfs" : "html", name);
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

function portableStoredName(value: string | undefined, kind: AcquisitionKind): string | null {
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

function storedFileExists(kind: AcquisitionKind, name: string | null): boolean {
  if (!name) {
    return false;
  }
  return existsSync(localFilePath(kind === "pdf" ? "pdfs" : "html", name));
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "PaperAssistant/1.0 (+local research library)", ...extraHeaders },
    });
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
  } finally {
    clearTimeout(timeout);
  }
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

async function acquirePdf(payload: SourceAcquisitionRequest): Promise<{ kind: AcquisitionKind; storedPath: string; fileUrl: string; sourceUrl: string }> {
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
      const directory = join(libraryDataDirectory(), "pdfs");
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

async function acquireHtml(payload: SourceAcquisitionRequest): Promise<{ kind: AcquisitionKind; storedPath: string; fileUrl: string; sourceUrl: string }> {
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
  const directory = join(libraryDataDirectory(), "html_snapshots");
  mkdirSync(directory, { recursive: true });
  const storedPath = acquisitionFilename(payload.title, source, ".html");
  const target = join(directory, storedPath);
  if (!existsSync(target)) {
    writeFileSync(target, html, { flag: "wx" });
  }
  return { kind: "html", storedPath, fileUrl: `/pa-files/html/${encodeURIComponent(storedPath)}`, sourceUrl: source.href };
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
  const paPath = join(libraryDataDirectory(), folder, name);
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
      bootstrapLibraryDirectory();
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
            const targetDirectory = join(libraryDataDirectory(), kind === "pdf" ? "pdfs" : "html_snapshots");
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
        if (url.pathname === "/api/source-acquisition") {
          if (request.method !== "POST") {
            sendJson(response, { error: "Use POST to validate or acquire a paper source." }, 405);
            return;
          }
          try {
            const payload = await readJsonBody<SourceAcquisitionRequest>(request);
            const localPath = portableStoredName(payload.localPath, "pdf");
            const htmlSnapshotPath = portableStoredName(payload.htmlSnapshotPath, "html");
            if ((payload.operation ?? "check") === "check") {
              sendJson(response, {
                localPath,
                htmlSnapshotPath,
                pdfExists: storedFileExists("pdf", localPath),
                htmlExists: storedFileExists("html", htmlSnapshotPath),
              });
              return;
            }
            const preferred = payload.preferred ?? "auto";
            if (preferred === "pdf") {
              sendJson(response, await acquirePdf(payload));
              return;
            }
            if (preferred === "html") {
              sendJson(response, await acquireHtml(payload));
              return;
            }
            try {
              sendJson(response, await acquirePdf(payload));
            } catch (pdfError) {
              try {
                sendJson(response, await acquireHtml(payload));
              } catch (htmlError) {
                throw new Error(`${pdfError instanceof Error ? pdfError.message : "PDF download failed"} ${htmlError instanceof Error ? htmlError.message : "HTML snapshot failed"}`);
              }
            }
          } catch (error) {
            sendJson(response, { error: error instanceof Error ? error.message : "The paper source could not be acquired." }, 400);
          }
          return;
        }
        if (url.pathname === "/api/storage-management") {
          if (request.method !== "POST") {
            sendJson(response, { error: "Use POST to inspect or manage PA storage." }, 405);
            return;
          }
          try {
            const payload = await readJsonBody<StorageManagementRequest>(request);
            if (payload.operation === "move") {
              const moved = moveLibraryDirectory(payload.targetDirectory, payload.confirmed);
              sendJson(response, { ...storageReport(payload, false), ...moved });
              return;
            }
            const clean = payload.operation === "clean";
            const repair = payload.operation === "repair";
            if ((clean || repair) && !payload.confirmed) {
              throw new Error(clean
                ? "Cleaning unlinked assets requires explicit confirmation."
                : "Repairing the PA database and filenames requires explicit confirmation.");
            }
            sendJson(response, storageReport(payload, clean, repair));
          } catch (error) {
            sendJson(response, { error: error instanceof Error ? error.message : "PA storage could not be inspected." }, 400);
          }
          return;
        }
        if (url.pathname === "/api/reveal-local-file") {
          if (request.method !== "POST") {
            sendJson(response, { error: "Use POST to reveal a stored PA file." }, 405);
            return;
          }
          try {
            const payload = await readJsonBody<RevealLocalFileRequest>(request);
            if (payload.kind !== "pdf" && payload.kind !== "html") {
              throw new Error("Choose a stored PDF or HTML snapshot.");
            }
            const name = portableStoredName(payload.path, payload.kind);
            if (!name) {
              throw new Error("No stored file was selected.");
            }
            revealLocalFile(payload.kind, name);
            sendJson(response, { ok: true, name });
          } catch (error) {
            sendJson(response, { error: error instanceof Error ? error.message : "The stored file could not be revealed." }, 400);
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
