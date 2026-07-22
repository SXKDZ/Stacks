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
    // A named accent from the fixed palette (blue/cyan/amber/green/rose), or
    // null for the default neutral. Shown on collection cards and paper chips.
    color: text("color"),
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

// --- AI feed: an opt-in notebook driving headless claude -p agents ---

export const feedSnippets = sqliteTable(
  "feed_snippets",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull().default(""),
    instruction: text("instruction").notNull().default(""),
    // A free-text note the user can edit anytime (notes-app style), separate
    // from the fixed opening instruction. Shown pinned above the agent thread.
    note: text("note").notNull().default(""),
    // JSON array of the remaining workflow steps ({label, prompt}) queued after
    // the opening turn, when this feed was started from a multi-step workflow.
    // The next step is offered as a one-click reply once a turn settles.
    workflowSteps: text("workflow_steps"),
    // queued | running | awaiting_input | done | error | stopped
    status: text("status").notNull().default("queued"),
    workingDir: text("working_dir"),
    // The claude -p session id, used with --resume for follow-up turns.
    sessionId: text("session_id"),
    error: text("error"),
    // The GitHub issue this feed is mirrored to (for remote/mobile access), if
    // GitHub inbox sync is configured. Null until the feed is first synced.
    issueNumber: integer("issue_number"),
    // The title last reconciled with GitHub — the 3-way base for rename sync, so
    // we can tell whether a divergence came from a local or a remote rename.
    issueTitleSynced: text("issue_title_synced"),
    // JSON array of the files attached to the opening turn ({label, relativePath,
    // kind}), staged under the feed working dir, so the UI can list and link them.
    attachments: text("attachments"),
    // Cumulative agent usage across all turns, captured from the result event.
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    turns: integer("turns").notNull().default(0),
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
    // Correlates a tool_use with its tool_result (Anthropic tool_use id), so the
    // UI can pair them even when the agent issues tool calls in parallel.
    toolUseId: text("tool_use_id"),
    // The GitHub issue-comment id this message was mirrored to or ingested from,
    // so sync neither double-posts nor re-ingests a comment. Null when local-only.
    githubCommentId: integer("github_comment_id"),
    // JSON array of files attached to this turn ({label, relativePath, kind}),
    // for reply turns that carried uploads/papers. Null when none.
    attachments: text("attachments"),
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
    // The GitHub comment mirroring this proposal + its status, so mobile sees
    // the proposed change and whether it was applied/rejected. Null until synced.
    githubCommentId: integer("github_comment_id"),
    // The status last reflected in that comment, so sync only edits on change.
    githubStatusSynced: text("github_status_synced"),
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
