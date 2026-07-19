import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import type { LibraryQuerier } from "@/db/client";
import {
  authors,
  collections,
  paperAuthors,
  paperCollections,
  papers,
  venues,
} from "@/db/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface MutationRequest {
  entity?: "paper" | "author" | "venue" | "collection";
  action?: "create" | "bulk-create" | "update" | "delete" | "bulk-update" | "bulk-delete";
  id?: string;
  ids?: string[];
  data?: Record<string, unknown>;
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

/** Turn raw SQLite errors into user-facing messages, hiding internal detail. */
function describeDbError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed/i.test(raw)) {
    if (/papers\.doi/i.test(raw)) return "A paper with this DOI is already in your library.";
    return "This record already exists in your library.";
  }
  if (/FOREIGN KEY constraint failed/i.test(raw)) {
    return "A linked record (venue, author, or collection) could not be resolved.";
  }
  return raw;
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

/** Coerce an arbitrary client value into something SQLite can bind as text. */
function textValue(value: unknown): string | null {
  if (value === "" || value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

async function readSnapshot() {
  const database = await ensureDatabase();
  const paperRows = database
    .select({ paper: papers, venueName: venues.name, venueAcronym: venues.acronym })
    .from(papers)
    .leftJoin(venues, eq(venues.id, papers.venueId))
    .orderBy(desc(papers.addedAt))
    .all();
  const authorLinks = database
    .select({
      paperId: paperAuthors.paperId,
      authorId: paperAuthors.authorId,
      authorOrder: paperAuthors.authorOrder,
      corresponding: paperAuthors.corresponding,
      displayName: authors.displayName,
      orcid: authors.orcid,
    })
    .from(paperAuthors)
    .innerJoin(authors, eq(authors.id, paperAuthors.authorId))
    .orderBy(paperAuthors.paperId, paperAuthors.authorOrder)
    .all();
  const collectionLinks = database
    .select({ paperId: paperCollections.paperId, id: collections.id, name: collections.name })
    .from(paperCollections)
    .innerJoin(collections, eq(collections.id, paperCollections.collectionId))
    .orderBy(collections.name)
    .all();
  const authorRows = database
    .select({
      author: authors,
      paperCount: sql<number>`count(distinct ${paperAuthors.paperId})`,
      latestYear: max(papers.year),
    })
    .from(authors)
    .leftJoin(paperAuthors, eq(paperAuthors.authorId, authors.id))
    .leftJoin(papers, eq(papers.id, paperAuthors.paperId))
    .groupBy(authors.id)
    .orderBy(sql`${authors.displayName} collate nocase`)
    .all();
  const venueRows = database
    .select({
      venue: venues,
      paperCount: sql<number>`count(distinct ${papers.id})`,
      latestYear: max(papers.year),
    })
    .from(venues)
    .leftJoin(papers, eq(papers.venueId, venues.id))
    .groupBy(venues.id)
    .orderBy(sql`${venues.name} collate nocase`)
    .all();
  const collectionRows = database
    .select({
      collection: collections,
      paperCount: sql<number>`count(distinct ${paperCollections.paperId})`,
    })
    .from(collections)
    .leftJoin(paperCollections, eq(paperCollections.collectionId, collections.id))
    .groupBy(collections.id)
    .orderBy(sql`${collections.name} collate nocase`)
    .all();

  const paperList = paperRows.map(({ paper, venueName, venueAcronym }) => {
    const paperAuthorList = authorLinks
      .filter((link) => link.paperId === paper.id)
      .map((link) => ({
        id: link.authorId,
        displayName: link.displayName,
        orcid: cleanString(link.orcid),
        order: link.authorOrder,
        corresponding: link.corresponding,
      }));
    const paperCollectionList = collectionLinks
      .filter((link) => link.paperId === paper.id)
      .map((link) => ({ id: link.id, name: link.name }));
    return {
      id: paper.id,
      title: paper.title,
      abstract: paper.abstract,
      year: paper.year,
      paperType: paper.paperType,
      volume: paper.volume,
      issue: paper.issue,
      pages: paper.pages,
      category: paper.category,
      doi: paper.doi,
      arxivId: paper.arxivId,
      preprintId: paper.preprintId,
      semanticScholarId: paper.semanticScholarId,
      url: paper.url,
      pdfUrl: paper.pdfUrl || (paper.localPath ? `/pa-files/pdfs/${encodeURIComponent(paper.localPath)}` : null),
      localPath: paper.localPath,
      htmlSnapshotPath: paper.htmlSnapshotPath,
      htmlUrl: paper.htmlSnapshotPath ? `/pa-files/html/${encodeURIComponent(paper.htmlSnapshotPath)}` : null,
      summary: paper.summary,
      notes: paper.notes,
      readingStatus: paper.readingStatus,
      favorite: paper.favorite,
      venueId: paper.venueId,
      venueName,
      venueAcronym,
      addedAt: paper.addedAt,
      updatedAt: paper.updatedAt,
      authors: paperAuthorList,
      collections: paperCollectionList,
    };
  });

  const authorList = authorRows.map(({ author, paperCount, latestYear }) => ({
    id: author.id,
    displayName: author.displayName,
    givenName: cleanString(author.givenName),
    familyName: cleanString(author.familyName),
    orcid: cleanString(author.orcid),
    semanticScholarId: cleanString(author.semanticScholarId),
    notes: cleanString(author.notes),
    paperCount: Number(paperCount ?? 0),
    latestYear: cleanNumber(latestYear),
  }));

  const venueList = venueRows.map(({ venue, paperCount, latestYear }) => ({
    id: venue.id,
    name: venue.name,
    acronym: cleanString(venue.acronym),
    type: venue.type,
    publisher: cleanString(venue.publisher),
    url: cleanString(venue.url),
    notes: cleanString(venue.notes),
    paperCount: Number(paperCount ?? 0),
    latestYear: cleanNumber(latestYear),
  }));

  const collectionList = collectionRows.map(({ collection, paperCount }) => ({
    id: collection.id,
    name: collection.name,
    paperCount: Number(paperCount ?? 0),
  }));

  const thisYear = new Date().getFullYear();
  return {
    papers: paperList,
    authors: authorList,
    venues: venueList,
    collections: collectionList,
    stats: {
      papers: paperList.length,
      authors: authorList.length,
      venues: venueList.length,
      unread: paperList.filter((paper) => paper.readingStatus === "inbox").length,
      active: paperList.filter((paper) => paper.readingStatus === "reading").length,
      recent: paperList.filter((paper) => paper.year === thisYear).length,
    },
  };
}

/** Resolve (or create) the venue id for a paper mutation on the given querier. */
function resolveVenueId(
  querier: LibraryQuerier,
  data: Record<string, unknown>,
): string | null {
  const venueId = cleanString(data.venueId);
  if (venueId) {
    return venueId;
  }
  const venueName = cleanString(data.venueName);
  if (!venueName) {
    return null;
  }
  const existing = querier
    .select({ id: venues.id })
    .from(venues)
    .where(eq(sql`lower(${venues.name})`, venueName.toLowerCase()))
    .limit(1)
    .get();
  if (existing) {
    return existing.id;
  }
  const id = createId("venue");
  querier
    .insert(venues)
    .values({
      id,
      name: venueName,
      acronym: cleanString(data.venueAcronym),
      type: cleanString(data.venueType) ?? "conference",
    })
    .run();
  return id;
}

/**
 * Insert the authorship rows for a paper on the given querier. Existing authors
 * are resolved with a single batched `IN (...)` lookup (not one query per name),
 * duplicate names within the same paper collapse to one row, and real
 * corresponding-author data is preserved when provided.
 */
function writeAuthors(
  querier: LibraryQuerier,
  paperId: string,
  value: unknown,
  correspondingValue?: unknown,
): void {
  const names: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value)) {
    for (const raw of value) {
      const name = cleanString(raw);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  if (!names.length) {
    return;
  }

  const correspondingNames = new Set(
    (Array.isArray(correspondingValue) ? correspondingValue : [])
      .map(cleanString)
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLowerCase()),
  );

  // One query resolves every already-known author id, avoiding per-name lookups.
  const existingRows = querier
    .select({ id: authors.id, key: sql<string>`lower(${authors.displayName})` })
    .from(authors)
    .where(inArray(sql`lower(${authors.displayName})`, names.map((name) => name.toLowerCase())))
    .all();
  const existingByKey = new Map(existingRows.map((row) => [row.key, row.id]));

  names.forEach((name, index) => {
    const key = name.toLowerCase();
    let authorId = existingByKey.get(key);
    if (!authorId) {
      authorId = createId("author");
      existingByKey.set(key, authorId);
      querier.insert(authors).values({ id: authorId, displayName: name }).run();
    }
    const corresponding = correspondingNames.size
      ? correspondingNames.has(key)
      : index === 0;
    querier
      .insert(paperAuthors)
      .values({ paperId, authorId, authorOrder: index, corresponding })
      .onConflictDoUpdate({
        target: [paperAuthors.paperId, paperAuthors.authorId],
        set: { authorOrder: index, corresponding },
      })
      .run();
  });
}

/** Resolve collection names to ids on the given querier, creating any missing. */
function resolveCollectionIdsByName(querier: LibraryQuerier, collectionNames: unknown): string[] {
  const names = Array.from(new Set(
    (Array.isArray(collectionNames) ? collectionNames : [])
      .map(cleanString)
      .filter((name): name is string => Boolean(name)),
  ));
  if (!names.length) {
    return [];
  }
  const existingRows = querier
    .select({ id: collections.id, key: sql<string>`lower(${collections.name})` })
    .from(collections)
    .where(inArray(sql`lower(${collections.name})`, names.map((name) => name.toLowerCase())))
    .all();
  const existingByKey = new Map(existingRows.map((row) => [row.key, row.id]));
  const ids: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    let id = existingByKey.get(key);
    if (!id) {
      id = createId("collection");
      existingByKey.set(key, id);
      querier.insert(collections).values({ id, name }).run();
    }
    ids.push(id);
  }
  return ids;
}

/**
 * Return the id of an existing paper that matches this record by a strong
 * identifier (DOI, arXiv id, or Semantic Scholar id), used to skip duplicates on
 * import. Title is intentionally not matched here — it is too noisy for dedup.
 */
function findDuplicatePaper(querier: LibraryQuerier, data: Record<string, unknown>): string | null {
  const doi = cleanString(data.doi);
  const arxivId = cleanString(data.arxivId);
  const semanticScholarId = cleanString(data.semanticScholarId);
  const checks: Array<ReturnType<typeof eq>> = [];
  if (doi) checks.push(eq(papers.doi, doi));
  if (arxivId) checks.push(eq(papers.arxivId, arxivId));
  if (semanticScholarId) checks.push(eq(papers.semanticScholarId, semanticScholarId));
  for (const condition of checks) {
    const existing = querier.select({ id: papers.id }).from(papers).where(condition).limit(1).get();
    if (existing) {
      return existing.id;
    }
  }
  return null;
}

async function createPaper(data: Record<string, unknown>): Promise<void> {
  const title = cleanString(data.title);
  if (!title) {
    throw new Error("A paper title is required.");
  }
  const database = await ensureDatabase();
  const id = createId("paper");
  // The whole paper — venue, row, authorship, collection links — commits in one
  // transaction so a mid-flight failure can never leave a partial record.
  database.transaction((tx) => {
    const venueId = resolveVenueId(tx, data);
    const collectionIds = Array.isArray(data.collectionNames)
      ? resolveCollectionIdsByName(tx, data.collectionNames)
      : (Array.isArray(data.collectionIds) ? data.collectionIds : [])
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));

    tx.insert(papers).values({
      id,
      title,
      abstract: cleanString(data.abstract) ?? "",
      year: cleanNumber(data.year),
      paperType: cleanString(data.paperType) ?? "article",
      volume: cleanString(data.volume),
      issue: cleanString(data.issue),
      pages: cleanString(data.pages),
      category: cleanString(data.category),
      doi: cleanString(data.doi),
      arxivId: cleanString(data.arxivId),
      preprintId: cleanString(data.preprintId),
      semanticScholarId: cleanString(data.semanticScholarId),
      url: cleanString(data.url),
      pdfUrl: cleanString(data.pdfUrl),
      localPath: cleanString(data.localPath),
      htmlSnapshotPath: cleanString(data.htmlSnapshotPath),
      summary: cleanString(data.summary) ?? "",
      notes: cleanString(data.notes) ?? "",
      readingStatus: cleanString(data.readingStatus) ?? "inbox",
      favorite: Boolean(data.favorite),
      venueId,
    }).run();

    writeAuthors(tx, id, data.authors, data.correspondingAuthors);

    for (const collectionId of collectionIds) {
      tx.insert(paperCollections)
        .values({ paperId: id, collectionId })
        .onConflictDoNothing()
        .run();
    }
  });
}

const entityTables = {
  author: authors,
  venue: venues,
  collection: collections,
} as const;

const entityFields = {
  author: {
    displayName: authors.displayName,
    givenName: authors.givenName,
    familyName: authors.familyName,
    orcid: authors.orcid,
    notes: authors.notes,
  },
  venue: {
    name: venues.name,
    acronym: venues.acronym,
    type: venues.type,
    publisher: venues.publisher,
    url: venues.url,
    notes: venues.notes,
  },
  collection: {
    name: collections.name,
  },
} as const;

async function createEntity(
  entity: "author" | "venue" | "collection",
  data: Record<string, unknown>,
): Promise<string> {
  const database = await ensureDatabase();
  const id = createId(entity);
  if (entity === "author") {
    const name = cleanString(data.displayName);
    if (!name) {
      throw new Error("An author name is required.");
    }
    database.insert(authors).values({
      id,
      displayName: name,
      givenName: cleanString(data.givenName),
      familyName: cleanString(data.familyName),
      orcid: cleanString(data.orcid),
      notes: cleanString(data.notes),
    }).run();
    return id;
  }
  if (entity === "venue") {
    const name = cleanString(data.name);
    if (!name) {
      throw new Error("A venue name is required.");
    }
    database.insert(venues).values({
      id,
      name,
      acronym: cleanString(data.acronym),
      type: cleanString(data.type) ?? "conference",
      publisher: cleanString(data.publisher),
      url: cleanString(data.url),
      notes: cleanString(data.notes),
    }).run();
    return id;
  }
  const name = cleanString(data.name);
  if (!name) {
    throw new Error("A collection name is required.");
  }
  database.transaction((tx) => {
    tx.insert(collections).values({ id, name }).run();
    syncCollectionPapers(tx, id, data.paperIds);
  });
  return id;
}

/** Reconcile a collection's paper membership to exactly `paperIds`. */
function syncCollectionPapers(querier: LibraryQuerier, collectionId: string, paperIds: unknown): void {
  if (!Array.isArray(paperIds)) {
    return;
  }
  const normalizedIds = Array.from(new Set(
    paperIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())),
  ));
  const existingIds = new Set(
    querier
      .select({ paperId: paperCollections.paperId })
      .from(paperCollections)
      .where(eq(paperCollections.collectionId, collectionId))
      .all()
      .map((row) => row.paperId),
  );
  const desiredIds = new Set(normalizedIds);
  for (const paperId of normalizedIds) {
    if (!existingIds.has(paperId)) {
      querier.insert(paperCollections).values({ paperId, collectionId }).onConflictDoNothing().run();
    }
  }
  for (const paperId of existingIds) {
    if (!desiredIds.has(paperId)) {
      querier
        .delete(paperCollections)
        .where(and(eq(paperCollections.paperId, paperId), eq(paperCollections.collectionId, collectionId)))
        .run();
    }
  }
}

/** Reconcile a paper's collection membership to exactly `collectionIds`. */
function syncPaperCollections(querier: LibraryQuerier, paperId: string, collectionIds: unknown): void {
  if (!Array.isArray(collectionIds)) {
    return;
  }
  const normalizedIds = Array.from(new Set(
    collectionIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())),
  ));
  const existingIds = new Set(
    querier
      .select({ collectionId: paperCollections.collectionId })
      .from(paperCollections)
      .where(eq(paperCollections.paperId, paperId))
      .all()
      .map((row) => row.collectionId),
  );
  const desiredIds = new Set(normalizedIds);
  for (const collectionId of normalizedIds) {
    if (!existingIds.has(collectionId)) {
      querier.insert(paperCollections).values({ paperId, collectionId }).onConflictDoNothing().run();
    }
  }
  for (const collectionId of existingIds) {
    if (!desiredIds.has(collectionId)) {
      querier
        .delete(paperCollections)
        .where(and(eq(paperCollections.paperId, paperId), eq(paperCollections.collectionId, collectionId)))
        .run();
    }
  }
}

/** Resolve collection names (creating any missing) then reconcile membership. */
function syncPaperCollectionsByName(querier: LibraryQuerier, paperId: string, collectionNames: unknown): void {
  if (!Array.isArray(collectionNames)) {
    return;
  }
  const ids = resolveCollectionIdsByName(querier, collectionNames);
  syncPaperCollections(querier, paperId, ids);
}

async function updateEntities(
  entity: "author" | "venue" | "collection",
  ids: string[],
  data: Record<string, unknown>,
): Promise<void> {
  if (!ids.length) {
    return;
  }
  const fields = entityFields[entity];
  const table = entityTables[entity];
  const assignments: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key in fields) {
      // Every editable column on these entities is TEXT; coerce so a stray
      // boolean/object from an API caller cannot crash the bind.
      assignments[key] = textValue(value);
    }
  }
  const database = await ensureDatabase();
  database.transaction((tx) => {
    if (Object.keys(assignments).length) {
      const updateSet = "updatedAt" in table ? { ...assignments, updatedAt: sql`CURRENT_TIMESTAMP` } : assignments;
      tx.update(table).set(updateSet as never).where(inArray(table.id, ids)).run();
    }
    if (entity === "collection" && "paperIds" in data) {
      for (const id of ids) {
        syncCollectionPapers(tx, id, data.paperIds);
      }
    }
  });
}

const paperTextFields = {
  volume: papers.volume,
  issue: papers.issue,
  pages: papers.pages,
  category: papers.category,
  doi: papers.doi,
  arxivId: papers.arxivId,
  preprintId: papers.preprintId,
  url: papers.url,
  pdfUrl: papers.pdfUrl,
  localPath: papers.localPath,
  htmlSnapshotPath: papers.htmlSnapshotPath,
} as const;

async function updatePaper(id: string, data: Record<string, unknown>): Promise<void> {
  const database = await ensureDatabase();
  if ("title" in data && !cleanString(data.title)) {
    throw new Error("A paper title is required.");
  }
  // Build a typed, coerced assignment set. Each column gets exactly the shape
  // SQLite expects (text/number/boolean-as-0/1), so no client value can crash
  // the bind the way the previous raw-passthrough did.
  const assignments: Record<string, unknown> = {};
  if ("title" in data) assignments.title = cleanString(data.title) ?? "";
  if ("abstract" in data) assignments.abstract = typeof data.abstract === "string" ? data.abstract : "";
  if ("summary" in data) assignments.summary = typeof data.summary === "string" ? data.summary : "";
  if ("notes" in data) assignments.notes = typeof data.notes === "string" ? data.notes : "";
  if ("paperType" in data) assignments.paperType = cleanString(data.paperType) ?? "other";
  if ("readingStatus" in data) assignments.readingStatus = cleanString(data.readingStatus) ?? "inbox";
  if ("year" in data) assignments.year = cleanNumber(data.year);
  if ("favorite" in data) assignments.favorite = Boolean(data.favorite);
  for (const key of Object.keys(paperTextFields) as Array<keyof typeof paperTextFields>) {
    if (key in data) {
      assignments[key] = textValue(data[key]);
    }
  }

  database.transaction((tx) => {
    if ("venueId" in data || "venueName" in data) {
      assignments.venueId = resolveVenueId(tx, data);
    }
    if (Object.keys(assignments).length) {
      tx.update(papers)
        .set({ ...assignments, updatedAt: sql`CURRENT_TIMESTAMP` } as never)
        .where(eq(papers.id, id))
        .run();
    }
    if (Array.isArray(data.authors)) {
      // Replace authorship atomically so a mid-flight failure can't leave the
      // paper with no authors.
      tx.delete(paperAuthors).where(eq(paperAuthors.paperId, id)).run();
      writeAuthors(tx, id, data.authors, data.correspondingAuthors);
    }
    if (Array.isArray(data.collectionNames)) {
      syncPaperCollectionsByName(tx, id, data.collectionNames);
    } else if (Array.isArray(data.collectionIds)) {
      syncPaperCollections(tx, id, data.collectionIds);
    }
  });
}

async function deleteEntities(entity: string, ids: string[]): Promise<void> {
  if (!ids.length) {
    return;
  }
  const table = {
    paper: papers,
    author: authors,
    venue: venues,
    collection: collections,
  }[entity];
  if (!table) {
    throw new Error("Unsupported entity type.");
  }
  const database = await ensureDatabase();
  database.delete(table).where(inArray(table.id, ids)).run();
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
        const database = await ensureDatabase();
        if (findDuplicatePaper(database, data)) {
          return jsonError("This paper is already in your library.", 409);
        }
        await createPaper(data);
      } else {
        await createEntity(body.entity, data);
      }
    } else if (body.action === "bulk-create") {
      if (body.entity !== "paper" || !Array.isArray(data.papers)) {
        return jsonError("Bulk create requires a paper list.");
      }
      if (data.papers.length > 500) {
        return jsonError("Import no more than 500 papers at a time.");
      }
      const database = await ensureDatabase();
      let added = 0;
      let skipped = 0;
      const failed: Array<{ title: string; reason: string }> = [];
      for (const paper of data.papers) {
        if (!paper || typeof paper !== "object" || Array.isArray(paper)) {
          continue;
        }
        const record = paper as Record<string, unknown>;
        try {
          if (findDuplicatePaper(database, record)) {
            skipped += 1;
            continue;
          }
          await createPaper(record);
          added += 1;
        } catch (error) {
          // Isolate per-record failures so one bad entry doesn't abort the import.
          failed.push({
            title: cleanString(record.title) ?? "Untitled",
            reason: describeDbError(error),
          });
        }
      }
      return Response.json({ ...(await readSnapshot()), importSummary: { added, skipped, failed } });
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
    const raw = error instanceof Error ? error.message : "";
    const status = /UNIQUE constraint failed/i.test(raw) ? 409 : 500;
    return jsonError(describeDbError(error) || "The library change failed.", status);
  }
}
