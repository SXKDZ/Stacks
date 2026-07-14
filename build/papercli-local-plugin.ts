import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

interface LocalMutation {
  entity?: "paper" | "author" | "venue" | "collection";
  action?: "create" | "update" | "delete" | "bulk-update" | "bulk-delete";
  id?: string;
  ids?: string[];
  data?: Record<string, unknown>;
}

type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;

const configuredDataDirectory = process.env.PAPERCLI_DATA_DIR?.trim();
const dataDirectory = configuredDataDirectory?.startsWith("~/")
  ? resolve(homedir(), configuredDataDirectory.slice(2))
  : resolve(configuredDataDirectory || join(homedir(), ".papercli"));
const sourceDatabase = join(dataDirectory, "papers.db");
const demoDirectory = resolve(process.cwd(), "data");
const demoDatabase = join(demoDirectory, "papercli-demo.db");

function columnNames(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
  return new Set(rows.map((row) => String(row.name)));
}

function ensureColumn(
  database: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  if (!columnNames(database, table).has(column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function normalizeVenues(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    acronym TEXT,
    type TEXT NOT NULL DEFAULT 'conference',
    publisher TEXT,
    url TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const venueRows = database
    .prepare(
      `SELECT DISTINCT trim(COALESCE(venue_full, '')) AS name,
              trim(COALESCE(venue_acronym, '')) AS acronym,
              COALESCE(paper_type, 'conference') AS paper_type
       FROM papers
       WHERE trim(COALESCE(venue_full, venue_acronym, '')) <> ''`,
    )
    .all() as SqlRow[];
  const insertVenue = database.prepare(
    "INSERT OR IGNORE INTO venues (id, name, acronym, type) VALUES (?, ?, ?, ?)",
  );
  const findVenue = database.prepare(
    "SELECT id FROM venues WHERE lower(name) = lower(?) LIMIT 1",
  );
  const attachVenue = database.prepare(
    `UPDATE papers SET venue_id = ?
     WHERE venue_id IS NULL
       AND (lower(trim(COALESCE(venue_full, ''))) = lower(?)
         OR (trim(COALESCE(venue_full, '')) = '' AND lower(trim(COALESCE(venue_acronym, ''))) = lower(?)))`,
  );
  for (const row of venueRows) {
    const name = String(row.name || row.acronym);
    const acronym = String(row.acronym || "") || null;
    const type = row.paper_type === "journal" ? "journal" : row.paper_type === "website" ? "website" : row.paper_type === "preprint" ? "preprint" : "conference";
    insertVenue.run(`venue-${randomUUID()}`, name, acronym, type);
    const venue = findVenue.get(name) as SqlRow | undefined;
    if (venue) {
      attachVenue.run(String(venue.id), String(row.name || ""), String(row.acronym || ""));
    }
  }
}

function prepareDemoDatabase(): DatabaseSync | null {
  if (!existsSync(sourceDatabase)) {
    return null;
  }
  mkdirSync(demoDirectory, { recursive: true });
  if (!existsSync(demoDatabase)) {
    copyFileSync(sourceDatabase, demoDatabase);
  }
  const database = new DatabaseSync(demoDatabase);
  database.exec("PRAGMA foreign_keys = ON");
  ensureColumn(database, "papers", "venue_id", "venue_id TEXT");
  ensureColumn(database, "papers", "summary", "summary TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "papers", "reading_status", "reading_status TEXT NOT NULL DEFAULT 'inbox'");
  ensureColumn(database, "papers", "favorite", "favorite INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "papers", "citation_count", "citation_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "authors", "orcid", "orcid TEXT");
  ensureColumn(database, "authors", "semantic_scholar_id", "semantic_scholar_id TEXT");
  ensureColumn(database, "authors", "h_index", "h_index INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "authors", "notes", "notes TEXT");
  ensureColumn(database, "collections", "color", "color TEXT NOT NULL DEFAULT 'violet'");
  database.exec(
    "UPDATE papers SET summary = notes, notes = '' WHERE summary = '' AND length(COALESCE(notes, '')) > 500",
  );
  database.exec(
    "UPDATE papers SET reading_status = 'reading' WHERE id IN (SELECT id FROM papers ORDER BY added_date DESC LIMIT 3) AND reading_status = 'inbox'",
  );
  database.exec(
    "UPDATE papers SET favorite = 1 WHERE id IN (SELECT id FROM papers ORDER BY added_date DESC LIMIT 5 OFFSET 1)",
  );
  normalizeVenues(database);
  return database;
}

function valueAsString(value: SqlValue | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const result = String(value).trim();
  return result || null;
}

function valueAsNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function snapshot(database: DatabaseSync) {
  const papers = database
    .prepare(
      `SELECT p.*, v.name AS normalized_venue_name,
              v.acronym AS normalized_venue_acronym
       FROM papers p
       LEFT JOIN venues v ON v.id = p.venue_id
       ORDER BY p.added_date DESC`,
    )
    .all() as SqlRow[];
  const authorLinks = database
    .prepare(
      `SELECT pa.paper_id, pa.author_id, pa.position,
              a.full_name, a.affiliation
       FROM paper_authors pa
       INNER JOIN authors a ON a.id = pa.author_id
       ORDER BY pa.paper_id, pa.position`,
    )
    .all() as SqlRow[];
  const collectionLinks = database
    .prepare(
      `SELECT pc.paper_id, c.id, c.name
       FROM paper_collections pc
       INNER JOIN collections c ON c.id = pc.collection_id
       ORDER BY c.name`,
    )
    .all() as SqlRow[];
  const paperRecords = papers.map((paper) => {
    const pdfPath = valueAsString(paper.pdf_path);
    const htmlPath = valueAsString(paper.html_snapshot_path);
    return {
      id: String(paper.id),
      title: String(paper.title),
      abstract: valueAsString(paper.abstract) ?? "",
      year: valueAsNumber(paper.year),
      paperType: valueAsString(paper.paper_type) ?? "article",
      volume: valueAsString(paper.volume),
      issue: valueAsString(paper.issue),
      pages: valueAsString(paper.pages),
      category: valueAsString(paper.category),
      doi: valueAsString(paper.doi),
      arxivId: valueAsString(paper.preprint_id),
      preprintId: valueAsString(paper.preprint_id),
      semanticScholarId: null,
      url: valueAsString(paper.url),
      pdfUrl: pdfPath ? `/papercli-files/pdfs/${encodeURIComponent(pdfPath)}` : null,
      localPath: pdfPath,
      htmlSnapshotPath: htmlPath,
      htmlUrl: htmlPath ? `/papercli-files/html/${encodeURIComponent(htmlPath)}` : null,
      summary: valueAsString(paper.summary) ?? "",
      notes: valueAsString(paper.notes) ?? "",
      readingStatus: valueAsString(paper.reading_status) ?? "inbox",
      favorite: Boolean(paper.favorite),
      citationCount: valueAsNumber(paper.citation_count) ?? 0,
      venueId: valueAsString(paper.venue_id),
      venueName: valueAsString(paper.normalized_venue_name) ?? valueAsString(paper.venue_full),
      venueAcronym: valueAsString(paper.normalized_venue_acronym) ?? valueAsString(paper.venue_acronym),
      addedAt: valueAsString(paper.added_date) ?? new Date().toISOString(),
      updatedAt: valueAsString(paper.modified_date) ?? new Date().toISOString(),
      authors: authorLinks
        .filter((link) => String(link.paper_id) === String(paper.id))
        .map((link, index) => ({
          id: String(link.author_id),
          displayName: String(link.full_name),
          affiliation: valueAsString(link.affiliation),
          orcid: null,
          order: valueAsNumber(link.position) ?? index,
          corresponding: index === 0,
        })),
      collections: collectionLinks
        .filter((link) => String(link.paper_id) === String(paper.id))
        .map((link, index) => ({
          id: String(link.id),
          name: String(link.name),
          color: ["violet", "cyan", "amber", "green", "rose"][index % 5],
        })),
    };
  });
  const authors = database
    .prepare(
      `SELECT a.*, COUNT(DISTINCT pa.paper_id) AS paper_count,
              MAX(p.year) AS latest_year
       FROM authors a
       INNER JOIN paper_authors pa ON pa.author_id = a.id
       INNER JOIN papers p ON p.id = pa.paper_id
       GROUP BY a.id
       ORDER BY a.full_name COLLATE NOCASE`,
    )
    .all() as SqlRow[];
  const authorRecords = authors.map((author) => ({
    id: String(author.id),
    displayName: String(author.full_name),
    givenName: valueAsString(author.first_name),
    familyName: valueAsString(author.last_name),
    affiliation: valueAsString(author.affiliation),
    orcid: valueAsString(author.orcid),
    semanticScholarId: valueAsString(author.semantic_scholar_id),
    hIndex: valueAsNumber(author.h_index) ?? 0,
    notes: valueAsString(author.notes),
    paperCount: valueAsNumber(author.paper_count) ?? 0,
    latestYear: valueAsNumber(author.latest_year),
  }));
  const venues = database
    .prepare(
      `SELECT v.*, COUNT(DISTINCT p.id) AS paper_count,
              MAX(p.year) AS latest_year
       FROM venues v
       LEFT JOIN papers p ON p.venue_id = v.id
       GROUP BY v.id
       ORDER BY v.name COLLATE NOCASE`,
    )
    .all() as SqlRow[];
  const venueRecords = venues.map((venue) => ({
    id: String(venue.id),
    name: String(venue.name),
    acronym: valueAsString(venue.acronym),
    type: valueAsString(venue.type) ?? "conference",
    publisher: valueAsString(venue.publisher),
    url: valueAsString(venue.url),
    notes: valueAsString(venue.notes),
    paperCount: valueAsNumber(venue.paper_count) ?? 0,
    latestYear: valueAsNumber(venue.latest_year),
  }));
  const collections = database
    .prepare(
      `SELECT c.*, COUNT(DISTINCT pc.paper_id) AS paper_count
       FROM collections c
       LEFT JOIN paper_collections pc ON pc.collection_id = c.id
       GROUP BY c.id
       ORDER BY c.name COLLATE NOCASE`,
    )
    .all() as SqlRow[];
  const collectionRecords = collections.map((collection, index) => ({
    id: String(collection.id),
    name: String(collection.name),
    description: valueAsString(collection.description) ?? "",
    color: valueAsString(collection.color) ?? ["violet", "cyan", "amber", "green", "rose"][index % 5],
    paperCount: valueAsNumber(collection.paper_count) ?? 0,
  }));
  const currentYear = new Date().getFullYear();
  return {
    papers: paperRecords,
    authors: authorRecords,
    venues: venueRecords,
    collections: collectionRecords,
    stats: {
      papers: paperRecords.length,
      authors: authorRecords.length,
      venues: venueRecords.length,
      unread: paperRecords.filter((paper) => paper.readingStatus === "inbox").length,
      active: paperRecords.filter((paper) => paper.readingStatus === "reading").length,
      recent: paperRecords.filter((paper) => paper.year === currentYear).length,
    },
    source: "papercli-copy",
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function updateRows(
  database: DatabaseSync,
  table: string,
  ids: string[],
  fields: Record<string, string>,
  data: Record<string, unknown>,
): void {
  const entries = Object.entries(data).filter(([key]) => key in fields);
  if (!entries.length) {
    return;
  }
  const assignment = entries.map(([key]) => `${fields[key]} = ?`).join(", ");
  const values = entries.map(([, value]) => value === "" ? null : (value as SqlValue));
  const statement = database.prepare(`UPDATE ${table} SET ${assignment} WHERE id = ?`);
  for (const id of ids) {
    statement.run(...values, id);
  }
}

function findOrCreateVenue(database: DatabaseSync, data: Record<string, unknown>): string | null {
  const venueId = stringValue(data.venueId);
  if (venueId) {
    return venueId;
  }
  const name = stringValue(data.venueName);
  if (!name) {
    return null;
  }
  const existing = database.prepare("SELECT id FROM venues WHERE lower(name) = lower(?) LIMIT 1").get(name) as SqlRow | undefined;
  if (existing) {
    return String(existing.id);
  }
  const id = `venue-${randomUUID()}`;
  database.prepare("INSERT INTO venues (id, name, acronym, type) VALUES (?, ?, ?, ?)").run(id, name, stringValue(data.venueAcronym), stringValue(data.venueType) ?? "conference");
  return id;
}

function attachAuthors(database: DatabaseSync, paperId: string, authorValue: unknown): void {
  if (!Array.isArray(authorValue)) {
    return;
  }
  const find = database.prepare("SELECT id FROM authors WHERE lower(full_name) = lower(?) LIMIT 1");
  const insertAuthor = database.prepare("INSERT INTO authors (full_name) VALUES (?)");
  const attach = database.prepare("INSERT OR REPLACE INTO paper_authors (paper_id, author_id, position) VALUES (?, ?, ?)");
  authorValue.map(stringValue).filter((name): name is string => Boolean(name)).forEach((name, index) => {
    const existing = find.get(name) as SqlRow | undefined;
    const authorId = existing?.id ?? Number(insertAuthor.run(name).lastInsertRowid);
    attach.run(paperId, authorId, index);
  });
}

function mutate(database: DatabaseSync, body: LocalMutation): void {
  if (!body.entity || !body.action) {
    throw new Error("Both entity and action are required.");
  }
  const data = body.data ?? {};
  const ids = body.ids ?? (body.id ? [body.id] : []);
  if (body.action === "create") {
    if (body.entity === "paper") {
      const title = stringValue(data.title);
      if (!title) {
        throw new Error("A paper title is required.");
      }
      const venueId = findOrCreateVenue(database, data);
      const result = database.prepare(
        `INSERT INTO papers (
          title, abstract, venue_full, venue_acronym, venue_id, year,
          volume, issue, pages, paper_type, doi, preprint_id, category,
          url, pdf_path, html_snapshot_path, summary, notes,
          reading_status, favorite, citation_count, added_date,
          modified_date, uuid
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
      ).run(
        title,
        stringValue(data.abstract),
        stringValue(data.venueName),
        stringValue(data.venueAcronym),
        venueId,
        valueAsNumber(data.year),
        stringValue(data.volume),
        stringValue(data.issue),
        stringValue(data.pages),
        stringValue(data.paperType) ?? "article",
        stringValue(data.doi),
        stringValue(data.preprintId) ?? stringValue(data.arxivId),
        stringValue(data.category),
        stringValue(data.url),
        stringValue(data.localPath),
        stringValue(data.htmlSnapshotPath),
        stringValue(data.summary) ?? "",
        stringValue(data.notes) ?? "",
        stringValue(data.readingStatus) ?? "inbox",
        data.favorite ? 1 : 0,
        valueAsNumber(data.citationCount) ?? 0,
        randomUUID(),
      );
      attachAuthors(database, String(result.lastInsertRowid), data.authors);
      return;
    }
    if (body.entity === "author") {
      const name = stringValue(data.displayName);
      if (!name) {
        throw new Error("An author name is required.");
      }
      database.prepare("INSERT INTO authors (full_name, first_name, last_name, affiliation, orcid, semantic_scholar_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)").run(name, stringValue(data.givenName), stringValue(data.familyName), stringValue(data.affiliation), stringValue(data.orcid), stringValue(data.semanticScholarId), stringValue(data.notes));
      return;
    }
    if (body.entity === "venue") {
      const name = stringValue(data.name);
      if (!name) {
        throw new Error("A venue name is required.");
      }
      database.prepare("INSERT INTO venues (id, name, acronym, type, publisher, url, notes) VALUES (?, ?, ?, ?, ?, ?, ?)").run(`venue-${randomUUID()}`, name, stringValue(data.acronym), stringValue(data.type) ?? "conference", stringValue(data.publisher), stringValue(data.url), stringValue(data.notes));
      return;
    }
    const name = stringValue(data.name);
    if (!name) {
      throw new Error("A collection name is required.");
    }
    database.prepare("INSERT INTO collections (name, description, color, created_at, last_modified) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run(name, stringValue(data.description) ?? "", stringValue(data.color) ?? "violet");
    return;
  }

  if (body.action === "update" || body.action === "bulk-update") {
    if (body.entity === "paper") {
      if ("venueId" in data || "venueName" in data) {
        data.venueId = findOrCreateVenue(database, data);
      }
      const normalizedPaperData: Record<string, unknown> = { ...data };
      if ("favorite" in data) {
        normalizedPaperData.favorite = data.favorite ? 1 : 0;
      }
      updateRows(database, "papers", ids, {
        title: "title",
        abstract: "abstract",
        year: "year",
        paperType: "paper_type",
        volume: "volume",
        issue: "issue",
        pages: "pages",
        category: "category",
        doi: "doi",
        preprintId: "preprint_id",
        url: "url",
        localPath: "pdf_path",
        htmlSnapshotPath: "html_snapshot_path",
        summary: "summary",
        notes: "notes",
        readingStatus: "reading_status",
        favorite: "favorite",
        venueId: "venue_id",
      }, normalizedPaperData);
      if (Array.isArray(data.authors) && ids[0]) {
        database.prepare("DELETE FROM paper_authors WHERE paper_id = ?").run(ids[0]);
        attachAuthors(database, ids[0], data.authors);
      }
      return;
    }
    if (body.entity === "author") {
      updateRows(database, "authors", ids, {
        displayName: "full_name",
        givenName: "first_name",
        familyName: "last_name",
        affiliation: "affiliation",
        orcid: "orcid",
        semanticScholarId: "semantic_scholar_id",
        notes: "notes",
      }, data);
      return;
    }
    if (body.entity === "venue") {
      updateRows(database, "venues", ids, {
        name: "name",
        acronym: "acronym",
        type: "type",
        publisher: "publisher",
        url: "url",
        notes: "notes",
      }, data);
      return;
    }
    updateRows(database, "collections", ids, {
      name: "name",
      description: "description",
      color: "color",
    }, data);
    return;
  }

  const table = {
    paper: "papers",
    author: "authors",
    venue: "venues",
    collection: "collections",
  }[body.entity];
  if (body.entity === "venue") {
    const clear = database.prepare("UPDATE papers SET venue_id = NULL WHERE venue_id = ?");
    ids.forEach((id) => clear.run(id));
  }
  const remove = database.prepare(`DELETE FROM ${table} WHERE id = ?`);
  ids.forEach((id) => remove.run(id));
}

async function parseBody(request: IncomingMessage): Promise<LocalMutation> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as LocalMutation;
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

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
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
  if (contentType === "text/html; charset=utf-8") {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self' data: https:; script-src 'none'; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' data: https:",
    );
  }
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
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; frame-ancestors 'self'",
  );
  response.setHeader("Content-Length", Buffer.byteLength(html));
  response.end(html);
}

export function papercliLocal(): Plugin {
  return {
    name: "papercli-local-library",
    apply: "serve",
    configureServer(server) {
      const database = prepareDemoDatabase();
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
            const targetDirectory = join(dataDirectory, kind === "pdf" ? "pdfs" : "html_snapshots");
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
              fileUrl: `/papercli-files/${kind === "pdf" ? "pdfs" : "html"}/${encodeURIComponent(storedPath)}`,
            });
          } catch (error) {
            sendJson(response, { error: error instanceof Error ? error.message : "The local file could not be loaded." }, 400);
          }
          return;
        }
        if (url.pathname === "/api/local-papercli") {
          if (!database) {
            sendJson(response, { error: "No PA database was found." }, 404);
            return;
          }
          try {
            if (request.method === "POST") {
              mutate(database, await parseBody(request));
            }
            sendJson(response, snapshot(database));
          } catch (error) {
            sendJson(response, { error: error instanceof Error ? error.message : "The local library request failed." }, 500);
          }
          return;
        }
        if (url.pathname.startsWith("/papercli-files/")) {
          const parts = url.pathname.split("/");
          const kind = parts[2];
          const requestedName = decodeURIComponent(parts.slice(3).join("/"));
          if (!requestedName || basename(requestedName) !== requestedName) {
            sendJson(response, { error: "Invalid local file path." }, 400);
            return;
          }
          if (kind === "pdfs") {
            serveFile(request, response, join(dataDirectory, "pdfs", requestedName), "application/pdf");
            return;
          }
          if (kind === "html") {
            serveHtmlSnapshot(response, join(dataDirectory, "html_snapshots", requestedName));
            return;
          }
          sendJson(response, { error: "Unsupported local file type." }, 404);
          return;
        }
        next();
      });
    },
  };
}
