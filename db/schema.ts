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
    orcid: text("orcid"),
    semanticScholarId: text("semantic_scholar_id"),
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

export const appSettings = sqliteTable("app_settings", {
  id: text("id").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// --- AI feed: an opt-in notebook driving headless claude -p agents ---

export const feedSnippets = sqliteTable(
  "feed_snippets",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull().default(""),
    instruction: text("instruction").notNull().default(""),
    // queued | running | awaiting_input | done | error | stopped
    status: text("status").notNull().default("queued"),
    workingDir: text("working_dir"),
    // The claude -p session id, used with --resume for follow-up turns.
    sessionId: text("session_id"),
    error: text("error"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("feed_snippets_updated_idx").on(table.updatedAt)],
);

export const feedMessages = sqliteTable(
  "feed_messages",
  {
    id: text("id").primaryKey(),
    snippetId: text("snippet_id")
      .notNull()
      .references(() => feedSnippets.id, { onDelete: "cascade", onUpdate: "cascade" }),
    // user | assistant | system | event
    role: text("role").notNull(),
    // text | tool_use | tool_result | result | error
    kind: text("kind").notNull().default("text"),
    content: text("content").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("feed_messages_snippet_idx").on(table.snippetId, table.createdAt)],
);

export const feedProposals = sqliteTable(
  "feed_proposals",
  {
    id: text("id").primaryKey(),
    snippetId: text("snippet_id")
      .notNull()
      .references(() => feedSnippets.id, { onDelete: "cascade", onUpdate: "cascade" }),
    messageId: text("message_id"),
    // JSON: { entity, action, data } describing a proposed library mutation.
    operation: text("operation").notNull(),
    // pending | approved | rejected | applied | failed
    status: text("status").notNull().default("pending"),
    resultSummary: text("result_summary"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    resolvedAt: text("resolved_at"),
  },
  (table) => [index("feed_proposals_snippet_idx").on(table.snippetId)],
);

export type PaperRecord = typeof papers.$inferSelect;
export type AuthorRecord = typeof authors.$inferSelect;
export type VenueRecord = typeof venues.$inferSelect;
export type CollectionRecord = typeof collections.$inferSelect;
export type FeedSnippetRecord = typeof feedSnippets.$inferSelect;
export type FeedMessageRecord = typeof feedMessages.$inferSelect;
export type FeedProposalRecord = typeof feedProposals.$inferSelect;
