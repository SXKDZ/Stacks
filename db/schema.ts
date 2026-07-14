import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const venues = sqliteTable(
  "venues",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    acronym: text("acronym"),
    type: text("type").notNull().default("conference"),
    publisher: text("publisher"),
    url: text("url"),
    notes: text("notes"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("venues_name_unique").on(table.name)],
);

export const papers = sqliteTable(
  "papers",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    abstract: text("abstract").notNull().default(""),
    year: integer("year"),
    paperType: text("paper_type").notNull().default("article"),
    volume: text("volume"),
    issue: text("issue"),
    pages: text("pages"),
    category: text("category"),
    doi: text("doi"),
    arxivId: text("arxiv_id"),
    preprintId: text("preprint_id"),
    semanticScholarId: text("semantic_scholar_id"),
    url: text("url"),
    pdfUrl: text("pdf_url"),
    localPath: text("local_path"),
    htmlSnapshotPath: text("html_snapshot_path"),
    summary: text("summary").notNull().default(""),
    notes: text("notes").notNull().default(""),
    readingStatus: text("reading_status").notNull().default("inbox"),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    citationCount: integer("citation_count").notNull().default(0),
    venueId: text("venue_id").references(() => venues.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    addedAt: text("added_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("papers_doi_unique").on(table.doi),
    index("papers_title_idx").on(table.title),
    index("papers_year_idx").on(table.year),
    index("papers_venue_idx").on(table.venueId),
  ],
);

export const authors = sqliteTable(
  "authors",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    givenName: text("given_name"),
    familyName: text("family_name"),
    affiliation: text("affiliation"),
    orcid: text("orcid"),
    semanticScholarId: text("semantic_scholar_id"),
    hIndex: integer("h_index").notNull().default(0),
    notes: text("notes"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("authors_name_idx").on(table.displayName),
    uniqueIndex("authors_orcid_unique").on(table.orcid),
  ],
);

export const paperAuthors = sqliteTable(
  "paper_authors",
  {
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade", onUpdate: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => authors.id, { onDelete: "cascade", onUpdate: "cascade" }),
    authorOrder: integer("author_order").notNull(),
    corresponding: integer("corresponding", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    primaryKey({ columns: [table.paperId, table.authorId] }),
    uniqueIndex("paper_author_order_unique").on(
      table.paperId,
      table.authorOrder,
    ),
    index("paper_authors_author_idx").on(table.authorId),
  ],
);

export const collections = sqliteTable(
  "collections",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    color: text("color").notNull().default("violet"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("collections_name_unique").on(table.name)],
);

export const paperCollections = sqliteTable(
  "paper_collections",
  {
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade", onUpdate: "cascade" }),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [primaryKey({ columns: [table.paperId, table.collectionId] })],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    color: text("color").notNull().default("slate"),
  },
  (table) => [uniqueIndex("tags_name_unique").on(table.name)],
);

export const paperTags = sqliteTable(
  "paper_tags",
  {
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade", onUpdate: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade", onUpdate: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.paperId, table.tagId] })],
);

export type PaperRecord = typeof papers.$inferSelect;
export type AuthorRecord = typeof authors.$inferSelect;
export type VenueRecord = typeof venues.$inferSelect;
export type CollectionRecord = typeof collections.$inferSelect;
