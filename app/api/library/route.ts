import { ensureDatabase } from "@/db/bootstrap";

export const dynamic = "force-dynamic";

interface MutationRequest {
  entity?: "paper" | "author" | "venue" | "collection";
  action?: "create" | "update" | "delete" | "bulk-update" | "bulk-delete";
  id?: string;
  ids?: string[];
  data?: Record<string, unknown>;
}

interface PaperRow {
  id: string;
  title: string;
  abstract: string;
  year: number | null;
  paper_type: string;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  category: string | null;
  doi: string | null;
  arxiv_id: string | null;
  preprint_id: string | null;
  semantic_scholar_id: string | null;
  url: string | null;
  pdf_url: string | null;
  local_path: string | null;
  html_snapshot_path: string | null;
  summary: string;
  notes: string;
  reading_status: string;
  favorite: number;
  citation_count: number;
  venue_id: string | null;
  added_at: string;
  updated_at: string;
  venue_name: string | null;
  venue_acronym: string | null;
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim();
  return cleaned || null;
}

function cleanNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function readSnapshot() {
  const database = await ensureDatabase();
  const [paperResult, authorLinkResult, collectionLinkResult, authorResult, venueResult, collectionResult] =
    await Promise.all([
      database
        .prepare(
          `SELECT p.*, v.name AS venue_name, v.acronym AS venue_acronym
           FROM papers p
           LEFT JOIN venues v ON v.id = p.venue_id
           ORDER BY p.added_at DESC`,
        )
        .all<PaperRow>(),
      database
        .prepare(
          `SELECT pa.paper_id, pa.author_id, pa.author_order, pa.corresponding,
                  a.display_name, a.affiliation, a.orcid
           FROM paper_authors pa
           INNER JOIN authors a ON a.id = pa.author_id
           ORDER BY pa.paper_id, pa.author_order`,
        )
        .all(),
      database
        .prepare(
          `SELECT pc.paper_id, c.id, c.name, c.color
           FROM paper_collections pc
           INNER JOIN collections c ON c.id = pc.collection_id
           ORDER BY c.name`,
        )
        .all(),
      database
        .prepare(
          `SELECT a.*, COUNT(DISTINCT pa.paper_id) AS paper_count,
                  MAX(p.year) AS latest_year
           FROM authors a
           LEFT JOIN paper_authors pa ON pa.author_id = a.id
           LEFT JOIN papers p ON p.id = pa.paper_id
           GROUP BY a.id
           ORDER BY a.display_name COLLATE NOCASE`,
        )
        .all(),
      database
        .prepare(
          `SELECT v.*, COUNT(DISTINCT p.id) AS paper_count,
                  MAX(p.year) AS latest_year
           FROM venues v
           LEFT JOIN papers p ON p.venue_id = v.id
           GROUP BY v.id
           ORDER BY v.name COLLATE NOCASE`,
        )
        .all(),
      database
        .prepare(
          `SELECT c.*, COUNT(DISTINCT pc.paper_id) AS paper_count
           FROM collections c
           LEFT JOIN paper_collections pc ON pc.collection_id = c.id
           GROUP BY c.id
           ORDER BY c.name COLLATE NOCASE`,
        )
        .all(),
    ]);

  const authorLinks = authorLinkResult.results as Array<Record<string, unknown>>;
  const collectionLinks = collectionLinkResult.results as Array<Record<string, unknown>>;
  const papers = paperResult.results.map((paper) => {
    const paperAuthors = authorLinks
      .filter((link) => link.paper_id === paper.id)
      .map((link) => ({
        id: String(link.author_id),
        displayName: String(link.display_name),
        affiliation: cleanString(link.affiliation),
        orcid: cleanString(link.orcid),
        order: Number(link.author_order),
        corresponding: Boolean(link.corresponding),
      }));
    const paperCollections = collectionLinks
      .filter((link) => link.paper_id === paper.id)
      .map((link) => ({
        id: String(link.id),
        name: String(link.name),
        color: String(link.color),
      }));

    return {
      id: paper.id,
      title: paper.title,
      abstract: paper.abstract,
      year: paper.year,
      paperType: paper.paper_type,
      volume: paper.volume,
      issue: paper.issue,
      pages: paper.pages,
      category: paper.category,
      doi: paper.doi,
      arxivId: paper.arxiv_id,
      preprintId: paper.preprint_id,
      semanticScholarId: paper.semantic_scholar_id,
      url: paper.url,
      pdfUrl: paper.pdf_url,
      localPath: paper.local_path,
      htmlSnapshotPath: paper.html_snapshot_path,
      htmlUrl: paper.html_snapshot_path,
      summary: paper.summary,
      notes: paper.notes,
      readingStatus: paper.reading_status,
      favorite: Boolean(paper.favorite),
      citationCount: paper.citation_count,
      venueId: paper.venue_id,
      venueName: paper.venue_name,
      venueAcronym: paper.venue_acronym,
      addedAt: paper.added_at,
      updatedAt: paper.updated_at,
      authors: paperAuthors,
      collections: paperCollections,
    };
  });

  const authors = (authorResult.results as Array<Record<string, unknown>>).map((author) => ({
    id: String(author.id),
    displayName: String(author.display_name),
    givenName: cleanString(author.given_name),
    familyName: cleanString(author.family_name),
    affiliation: cleanString(author.affiliation),
    orcid: cleanString(author.orcid),
    semanticScholarId: cleanString(author.semantic_scholar_id),
    hIndex: Number(author.h_index ?? 0),
    notes: cleanString(author.notes),
    paperCount: Number(author.paper_count ?? 0),
    latestYear: cleanNumber(author.latest_year),
  }));

  const venues = (venueResult.results as Array<Record<string, unknown>>).map((venue) => ({
    id: String(venue.id),
    name: String(venue.name),
    acronym: cleanString(venue.acronym),
    type: String(venue.type),
    publisher: cleanString(venue.publisher),
    url: cleanString(venue.url),
    notes: cleanString(venue.notes),
    paperCount: Number(venue.paper_count ?? 0),
    latestYear: cleanNumber(venue.latest_year),
  }));

  const collections = (collectionResult.results as Array<Record<string, unknown>>).map(
    (collection) => ({
      id: String(collection.id),
      name: String(collection.name),
      description: String(collection.description),
      color: String(collection.color),
      paperCount: Number(collection.paper_count ?? 0),
    }),
  );

  const thisYear = new Date().getFullYear();
  return {
    papers,
    authors,
    venues,
    collections,
    stats: {
      papers: papers.length,
      authors: authors.length,
      venues: venues.length,
      unread: papers.filter((paper) => paper.readingStatus === "inbox").length,
      active: papers.filter((paper) => paper.readingStatus === "reading").length,
      recent: papers.filter((paper) => paper.year === thisYear).length,
    },
  };
}

async function findOrCreateVenue(
  database: D1Database,
  data: Record<string, unknown>,
): Promise<string | null> {
  const venueId = cleanString(data.venueId);
  if (venueId) {
    return venueId;
  }
  const venueName = cleanString(data.venueName);
  if (!venueName) {
    return null;
  }
  const existing = await database
    .prepare("SELECT id FROM venues WHERE lower(name) = lower(?) LIMIT 1")
    .bind(venueName)
    .first<{ id: string }>();
  if (existing) {
    return existing.id;
  }
  const id = createId("venue");
  await database
    .prepare(
      "INSERT INTO venues (id, name, acronym, type) VALUES (?, ?, ?, ?)",
    )
    .bind(id, venueName, cleanString(data.venueAcronym), cleanString(data.venueType) ?? "conference")
    .run();
  return id;
}

async function attachAuthors(
  database: D1Database,
  paperId: string,
  value: unknown,
): Promise<void> {
  const names = Array.isArray(value)
    ? value.map(cleanString).filter((name): name is string => Boolean(name))
    : [];
  if (!names.length) {
    return;
  }

  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const existing = await database
      .prepare("SELECT id FROM authors WHERE lower(display_name) = lower(?) LIMIT 1")
      .bind(name)
      .first<{ id: string }>();
    const authorId = existing?.id ?? createId("author");
    if (!existing) {
      statements.push(
        database
          .prepare("INSERT INTO authors (id, display_name) VALUES (?, ?)")
          .bind(authorId, name),
      );
    }
    statements.push(
      database
        .prepare(
          "INSERT OR REPLACE INTO paper_authors (paper_id, author_id, author_order, corresponding) VALUES (?, ?, ?, ?)",
        )
        .bind(paperId, authorId, index, index === 0 ? 1 : 0),
    );
  }
  await database.batch(statements);
}

async function createPaper(data: Record<string, unknown>): Promise<void> {
  const title = cleanString(data.title);
  if (!title) {
    throw new Error("A paper title is required.");
  }
  const database = await ensureDatabase();
  const id = createId("paper");
  const venueId = await findOrCreateVenue(database, data);
  await database
    .prepare(
      `INSERT INTO papers (
        id, title, abstract, year, paper_type, volume, issue, pages, category,
        doi, arxiv_id, preprint_id, semantic_scholar_id, url, pdf_url,
        local_path, html_snapshot_path, summary, notes, reading_status,
        favorite, citation_count, venue_id, added_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .bind(
      id,
      title,
      cleanString(data.abstract) ?? "",
      cleanNumber(data.year),
      cleanString(data.paperType) ?? "article",
      cleanString(data.volume),
      cleanString(data.issue),
      cleanString(data.pages),
      cleanString(data.category),
      cleanString(data.doi),
      cleanString(data.arxivId),
      cleanString(data.preprintId),
      cleanString(data.semanticScholarId),
      cleanString(data.url),
      cleanString(data.pdfUrl),
      cleanString(data.localPath),
      cleanString(data.htmlSnapshotPath),
      cleanString(data.summary) ?? "",
      cleanString(data.notes) ?? "",
      cleanString(data.readingStatus) ?? "inbox",
      data.favorite ? 1 : 0,
      cleanNumber(data.citationCount) ?? 0,
      venueId,
    )
    .run();
  await attachAuthors(database, id, data.authors);
}

const entityConfigurations = {
  author: {
    table: "authors",
    fields: {
      displayName: "display_name",
      givenName: "given_name",
      familyName: "family_name",
      affiliation: "affiliation",
      orcid: "orcid",
      hIndex: "h_index",
      notes: "notes",
    },
  },
  venue: {
    table: "venues",
    fields: {
      name: "name",
      acronym: "acronym",
      type: "type",
      publisher: "publisher",
      url: "url",
      notes: "notes",
    },
  },
  collection: {
    table: "collections",
    fields: {
      name: "name",
      description: "description",
      color: "color",
    },
  },
} as const;

async function createEntity(
  entity: "author" | "venue" | "collection",
  data: Record<string, unknown>,
): Promise<void> {
  const database = await ensureDatabase();
  const id = createId(entity);
  if (entity === "author") {
    const name = cleanString(data.displayName);
    if (!name) {
      throw new Error("An author name is required.");
    }
    await database
      .prepare(
        `INSERT INTO authors (id, display_name, given_name, family_name, affiliation, orcid, h_index, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, name, cleanString(data.givenName), cleanString(data.familyName), cleanString(data.affiliation), cleanString(data.orcid), cleanNumber(data.hIndex) ?? 0, cleanString(data.notes))
      .run();
    return;
  }
  if (entity === "venue") {
    const name = cleanString(data.name);
    if (!name) {
      throw new Error("A venue name is required.");
    }
    await database
      .prepare(
        "INSERT INTO venues (id, name, acronym, type, publisher, url, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(id, name, cleanString(data.acronym), cleanString(data.type) ?? "conference", cleanString(data.publisher), cleanString(data.url), cleanString(data.notes))
      .run();
    return;
  }
  const name = cleanString(data.name);
  if (!name) {
    throw new Error("A collection name is required.");
  }
  await database
    .prepare(
      "INSERT INTO collections (id, name, description, color) VALUES (?, ?, ?, ?)",
    )
    .bind(id, name, cleanString(data.description) ?? "", cleanString(data.color) ?? "violet")
    .run();
}

async function updateEntities(
  entity: "author" | "venue" | "collection",
  ids: string[],
  data: Record<string, unknown>,
): Promise<void> {
  const configuration = entityConfigurations[entity];
  const entries = Object.entries(data).filter(([key]) => key in configuration.fields);
  if (!ids.length || !entries.length) {
    return;
  }
  const database = await ensureDatabase();
  const assignments = entries
    .map(([key]) => `${configuration.fields[key as keyof typeof configuration.fields]} = ?`)
    .join(", ");
  const values = entries.map(([, value]) => value ?? null);
  const statements = ids.map((id) => {
    return database
      .prepare(
        `UPDATE ${configuration.table} SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .bind(...values, id);
  });
  await database.batch(statements);
}

async function updatePaper(id: string, data: Record<string, unknown>): Promise<void> {
  const database = await ensureDatabase();
  const allowedFields = {
    title: "title",
    abstract: "abstract",
    year: "year",
    paperType: "paper_type",
    volume: "volume",
    issue: "issue",
    pages: "pages",
    category: "category",
    doi: "doi",
    arxivId: "arxiv_id",
    preprintId: "preprint_id",
    url: "url",
    pdfUrl: "pdf_url",
    localPath: "local_path",
    htmlSnapshotPath: "html_snapshot_path",
    summary: "summary",
    notes: "notes",
    readingStatus: "reading_status",
    favorite: "favorite",
  } as const;
  const entries = Object.entries(data).filter(([key]) => key in allowedFields);
  if ("venueId" in data || "venueName" in data) {
    const venueId = await findOrCreateVenue(database, data);
    entries.push(["venueId", venueId]);
  }
  const assignments = entries.map(([key]) => {
    if (key === "venueId") {
      return "venue_id = ?";
    }
    return `${allowedFields[key as keyof typeof allowedFields]} = ?`;
  });
  const values = entries.map(([key, value]) => {
    if (key === "favorite") {
      return value ? 1 : 0;
    }
    return value === "" ? null : value ?? null;
  });
  if (assignments.length) {
    await database
      .prepare(
        `UPDATE papers SET ${assignments.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .bind(...values, id)
      .run();
  }
  if (Array.isArray(data.authors)) {
    await database.prepare("DELETE FROM paper_authors WHERE paper_id = ?").bind(id).run();
    await attachAuthors(database, id, data.authors);
  }
}

async function deleteEntities(entity: string, ids: string[]): Promise<void> {
  if (!ids.length) {
    return;
  }
  const table = {
    paper: "papers",
    author: "authors",
    venue: "venues",
    collection: "collections",
  }[entity];
  if (!table) {
    throw new Error("Unsupported entity type.");
  }
  const database = await ensureDatabase();
  const statements = ids.map((id) => {
    return database.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id);
  });
  await database.batch(statements);
}

export async function GET(): Promise<Response> {
  try {
    return Response.json(await readSnapshot());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the library.";
    return jsonError(message, 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as MutationRequest;
    if (!body.entity || !body.action) {
      return jsonError("Both entity and action are required.");
    }
    const data = body.data ?? {};
    const ids = body.ids ?? (body.id ? [body.id] : []);

    if (body.action === "create") {
      if (body.entity === "paper") {
        await createPaper(data);
      } else {
        await createEntity(body.entity, data);
      }
    } else if (body.action === "update" || body.action === "bulk-update") {
      if (body.entity === "paper") {
        if (!ids[0]) {
          return jsonError("A paper id is required for updates.");
        }
        await updatePaper(ids[0], data);
      } else {
        await updateEntities(body.entity, ids, data);
      }
    } else if (body.action === "delete" || body.action === "bulk-delete") {
      await deleteEntities(body.entity, ids);
    }

    return Response.json(await readSnapshot());
  } catch (error) {
    const message = error instanceof Error ? error.message : "The library change failed.";
    return jsonError(message, 500);
  }
}
