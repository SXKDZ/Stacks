import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function expandPath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return resolve(value);
}

const sourceDirectory = expandPath(process.env.PA_LEGACY_IMPORT_DIR || "~/.papercli");
const sourcePath = join(sourceDirectory, "papers.db");
const outputPath = resolve(process.cwd(), "data", "legacy-import.sql");

if (!existsSync(sourcePath)) {
  throw new Error(`No read-only import source was found at ${sourcePath}`);
}

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function text(value) {
  const normalized = value === null || value === undefined ? "" : String(value).trim();
  return normalized || null;
}

function legacyId(entity, id) {
  return `legacy-${entity}-${id}`;
}

function venueRecord(paper) {
  const fullName = text(paper.venue_full);
  const acronym = text(paper.venue_acronym);
  const isPreprint = text(paper.paper_type)?.toLowerCase() === "preprint";
  if (!fullName && !acronym && !isPreprint) return null;
  const name = fullName || acronym || "arXiv";
  const normalizedAcronym = acronym || (name.toLowerCase() === "arxiv" ? "arXiv" : null);
  const type = isPreprint ? "preprint" : text(paper.paper_type) || "conference";
  const id = `venue-${createHash("sha1").update(name.toLowerCase()).digest("hex").slice(0, 12)}`;
  return { id, name, acronym: normalizedAcronym, type };
}

const source = new DatabaseSync(sourcePath, { readOnly: true });
const papers = source.prepare("SELECT * FROM papers ORDER BY added_date DESC").all();
const authors = source.prepare("SELECT * FROM authors WHERE id IN (SELECT DISTINCT author_id FROM paper_authors) ORDER BY id").all();
const paperAuthors = source.prepare("SELECT * FROM paper_authors ORDER BY paper_id, position").all();
const collections = source.prepare("SELECT * FROM collections ORDER BY id").all();
const paperCollections = source.prepare("SELECT * FROM paper_collections ORDER BY paper_id, collection_id").all();
source.close();

const venues = new Map();
for (const paper of papers) {
  const venue = venueRecord(paper);
  if (venue) venues.set(venue.id, venue);
}

const readingIds = new Set(papers.slice(0, 3).map((paper) => String(paper.id)));
const favoriteIds = new Set(papers.slice(1, 6).map((paper) => String(paper.id)));
const seenDois = new Set();
const statements = [
  "PRAGMA foreign_keys = OFF;",
  "BEGIN TRANSACTION;",
  "DELETE FROM paper_tags;",
  "DELETE FROM tags;",
  "DELETE FROM paper_collections;",
  "DELETE FROM paper_authors;",
  "DELETE FROM papers;",
  "DELETE FROM authors;",
  "DELETE FROM venues;",
  "DELETE FROM collections;",
];

for (const venue of venues.values()) {
  statements.push(`INSERT INTO venues (id, name, acronym, type, publisher, url, notes) VALUES (${sql(venue.id)}, ${sql(venue.name)}, ${sql(venue.acronym)}, ${sql(venue.type)}, NULL, ${sql(venue.name === "arXiv" ? "https://arxiv.org" : null)}, NULL);`);
}

for (const author of authors) {
  statements.push(`INSERT INTO authors (id, display_name, given_name, family_name, orcid, semantic_scholar_id, notes) VALUES (${sql(legacyId("author", author.id))}, ${sql(author.full_name)}, ${sql(author.first_name)}, ${sql(author.last_name)}, NULL, NULL, NULL);`);
}

for (let index = 0; index < collections.length; index += 1) {
  const collection = collections[index];
  statements.push(`INSERT INTO collections (id, name, created_at, updated_at) VALUES (${sql(legacyId("collection", collection.id))}, ${sql(collection.name)}, ${sql(collection.created_at)}, ${sql(collection.last_modified || collection.created_at)});`);
}

for (const paper of papers) {
  const venue = venueRecord(paper);
  const rawDoi = text(paper.doi);
  const doiKey = rawDoi?.toLowerCase();
  const doi = doiKey && !seenDois.has(doiKey) ? rawDoi : null;
  if (doiKey) seenDois.add(doiKey);
  const rawNotes = text(paper.notes) || "";
  const summary = rawNotes.length > 500 ? rawNotes : "";
  const notes = rawNotes.length > 500 ? "" : rawNotes;
  const preprintId = text(paper.preprint_id);
  const paperType = text(paper.paper_type) || "article";
  statements.push(`INSERT INTO papers (
    id, title, abstract, year, paper_type, volume, issue, pages, category,
    doi, arxiv_id, preprint_id, semantic_scholar_id, url, pdf_url, local_path,
    html_snapshot_path, summary, notes, reading_status, favorite,
    venue_id, added_at, updated_at
  ) VALUES (
    ${sql(legacyId("paper", paper.id))}, ${sql(paper.title)}, ${sql(text(paper.abstract) || "")}, ${sql(paper.year)}, ${sql(paperType)},
    ${sql(paper.volume)}, ${sql(paper.issue)}, ${sql(paper.pages)}, ${sql(paper.category)}, ${sql(doi)},
    ${sql(preprintId)}, ${sql(preprintId)}, NULL, ${sql(paper.url)}, NULL, ${sql(paper.pdf_path)},
    ${sql(paper.html_snapshot_path)}, ${sql(summary)}, ${sql(notes)}, ${sql(readingIds.has(String(paper.id)) ? "reading" : "inbox")},
    ${favoriteIds.has(String(paper.id)) ? 1 : 0}, ${sql(venue?.id)}, ${sql(paper.added_date)}, ${sql(paper.modified_date)}
  );`);
}

const importedPaperAuthors = new Set();
for (const link of paperAuthors) {
  const key = `${link.paper_id}:${link.author_id}`;
  if (importedPaperAuthors.has(key)) continue;
  importedPaperAuthors.add(key);
  statements.push(`INSERT INTO paper_authors (paper_id, author_id, author_order, corresponding) VALUES (${sql(legacyId("paper", link.paper_id))}, ${sql(legacyId("author", link.author_id))}, ${sql(link.position)}, ${Number(link.position) === 0 ? 1 : 0});`);
}

for (const link of paperCollections) {
  statements.push(`INSERT INTO paper_collections (paper_id, collection_id) VALUES (${sql(legacyId("paper", link.paper_id))}, ${sql(legacyId("collection", link.collection_id))});`);
}

statements.push("COMMIT;", "PRAGMA foreign_keys = ON;");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${statements.join("\n")}\n`, { mode: 0o600 });
console.log(`Prepared ${papers.length} papers, ${authors.length} authors, ${venues.size} venues, and ${collections.length} collections for D1 import.`);
