import { databasePath, ensureLibraryDirectories } from "./library-paths";
import { getLibraryDb, type LibraryDb } from "./client";
import { canonicalPreprintId } from "../app/lib/preprint-id";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    acronym TEXT,
    type TEXT NOT NULL DEFAULT 'conference',
    publisher TEXT,
    url TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS papers (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    abstract TEXT NOT NULL DEFAULT '',
    year INTEGER,
    paper_type TEXT NOT NULL DEFAULT 'article',
    volume TEXT,
    issue TEXT,
    pages TEXT,
    category TEXT,
    doi TEXT UNIQUE,
    preprint_id TEXT,
    semantic_scholar_id TEXT,
    url TEXT,
    pdf_url TEXT,
    local_path TEXT,
    html_snapshot_path TEXT,
    summary TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    reading_status TEXT NOT NULL DEFAULT 'inbox',
    favorite INTEGER NOT NULL DEFAULT 0,
    venue_id TEXT REFERENCES venues(id) ON DELETE SET NULL ON UPDATE CASCADE,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS authors (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    given_name TEXT,
    family_name TEXT,
    orcid TEXT UNIQUE,
    semantic_scholar_id TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS paper_authors (
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
    author_id TEXT NOT NULL REFERENCES authors(id) ON DELETE CASCADE ON UPDATE CASCADE,
    author_order INTEGER NOT NULL,
    corresponding INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (paper_id, author_id),
    UNIQUE (paper_id, author_order)
  )`,
  `CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS paper_collections (
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY (paper_id, collection_id)
  )`,
  `CREATE TABLE IF NOT EXISTS feed_snippets (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    instruction TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    session_id TEXT,
    model TEXT,
    effort TEXT,
    history_mode TEXT,
    error TEXT,
    issue_number INTEGER,
    issue_title_synced TEXT,
    collapsed INTEGER NOT NULL DEFAULT 0,
    issue_state_synced TEXT,
    attachments TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    turns INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS feed_messages (
    id TEXT PRIMARY KEY,
    snippet_id TEXT NOT NULL REFERENCES feed_snippets(id) ON DELETE CASCADE ON UPDATE CASCADE,
    role TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    content TEXT NOT NULL DEFAULT '',
    tool_use_id TEXT,
    github_comment_id INTEGER,
    attachments TEXT,
    attachments_synced INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS feed_proposals (
    id TEXT PRIMARY KEY,
    snippet_id TEXT NOT NULL REFERENCES feed_snippets(id) ON DELETE CASCADE ON UPDATE CASCADE,
    message_id TEXT,
    operation TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result_summary TEXT,
    github_comment_id INTEGER,
    github_status_synced TEXT,
    reported_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS feed_github_outbox (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    op TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE INDEX IF NOT EXISTS papers_title_idx ON papers(title)",
  "CREATE INDEX IF NOT EXISTS papers_year_idx ON papers(year)",
  "CREATE INDEX IF NOT EXISTS papers_venue_idx ON papers(venue_id)",
  "CREATE INDEX IF NOT EXISTS authors_name_idx ON authors(display_name)",
  "CREATE INDEX IF NOT EXISTS paper_authors_author_idx ON paper_authors(author_id)",
  "CREATE INDEX IF NOT EXISTS feed_snippets_updated_idx ON feed_snippets(updated_at)",
  "CREATE INDEX IF NOT EXISTS feed_messages_snippet_idx ON feed_messages(snippet_id, created_at)",
  "CREATE INDEX IF NOT EXISTS feed_proposals_snippet_idx ON feed_proposals(snippet_id)",
  "CREATE INDEX IF NOT EXISTS feed_github_outbox_repo_idx ON feed_github_outbox(repo)",
];

const seedStatements = [
  [
    `INSERT OR IGNORE INTO venues (id, name, acronym, type, publisher, url) VALUES (?, ?, ?, ?, ?, ?)`,
    ["venue-neurips", "Conference on Neural Information Processing Systems", "NeurIPS", "conference", "NeurIPS Foundation", "https://neurips.cc"],
  ],
  [
    `INSERT OR IGNORE INTO venues (id, name, acronym, type, publisher, url) VALUES (?, ?, ?, ?, ?, ?)`,
    ["venue-chi", "ACM Conference on Human Factors in Computing Systems", "CHI", "conference", "ACM", "https://chi.acm.org"],
  ],
  [
    `INSERT OR IGNORE INTO venues (id, name, acronym, type, publisher, url) VALUES (?, ?, ?, ?, ?, ?)`,
    ["venue-nature", "Nature Machine Intelligence", "NMI", "journal", "Springer Nature", "https://www.nature.com/natmachintell"],
  ],
  [
    `INSERT OR IGNORE INTO venues (id, name, acronym, type, publisher, url) VALUES (?, ?, ?, ?, ?, ?)`,
    ["venue-arxiv", "arXiv", "arXiv", "preprint", "Cornell Tech", "https://arxiv.org"],
  ],
  [
    `INSERT OR IGNORE INTO authors (id, display_name, given_name, family_name, orcid, semantic_scholar_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ["author-amina", "Amina Rahman", "Amina", "Rahman", "0000-0002-3141-5926", "s2-amina"],
  ],
  [
    `INSERT OR IGNORE INTO authors (id, display_name, given_name, family_name, orcid, semantic_scholar_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ["author-theo", "Theo Martins", "Theo", "Martins", "0000-0001-7462-9012", "s2-theo"],
  ],
  [
    `INSERT OR IGNORE INTO authors (id, display_name, given_name, family_name, orcid, semantic_scholar_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ["author-yuki", "Yuki Tanaka", "Yuki", "Tanaka", "0000-0003-8420-1187", "s2-yuki"],
  ],
  [
    `INSERT OR IGNORE INTO authors (id, display_name, given_name, family_name, orcid, semantic_scholar_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ["author-lena", "Lena Ortiz", "Lena", "Ortiz", "0000-0002-5579-2401", "s2-lena"],
  ],
  [
    `INSERT OR IGNORE INTO authors (id, display_name, given_name, family_name, orcid, semantic_scholar_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ["author-sam", "Samir Patel", "Samir", "Patel", "0000-0001-6034-8752", "s2-samir"],
  ],
  [
    `INSERT OR IGNORE INTO papers (id, title, abstract, year, paper_type, doi, semantic_scholar_id, url, pdf_url, notes, reading_status, favorite, venue_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["paper-retrieval", "Adaptive Retrieval for Long-Context Scientific Assistants", "We introduce a retrieval controller that learns when and where to search across long scientific documents, improving grounded question answering while reducing unnecessary context.", 2026, "conference", "10.5555/pa.2026.001", "s2-retrieval", "https://arxiv.org/abs/2602.01472", "https://arxiv.org/pdf/2602.01472", "Compare the ablation on retrieval depth with our literature graph baseline.", "reading", 1, "venue-neurips", "2026-07-12T14:32:00Z"],
  ],
  [
    `INSERT OR IGNORE INTO papers (id, title, abstract, year, paper_type, doi, semantic_scholar_id, url, pdf_url, notes, reading_status, favorite, venue_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["paper-sensemaking", "Interfaces for Human–AI Literature Sensemaking", "A mixed-methods study of interface patterns that help researchers synthesize unfamiliar literatures with generative AI while preserving provenance and agency.", 2025, "conference", "10.1145/pa.2025.014", "s2-sensemaking", "https://dl.acm.org/doi/10.1145/pa.2025.014", null, "Useful taxonomy for the related-work workspace.", "complete", 1, "venue-chi", "2026-07-09T09:15:00Z"],
  ],
  [
    `INSERT OR IGNORE INTO papers (id, title, abstract, year, paper_type, preprint_id, semantic_scholar_id, url, pdf_url, notes, reading_status, favorite, venue_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["paper-agents", "Reliable Tool Use in Autonomous Research Agents", "We study failure recovery, verification, and cost-aware planning in autonomous agents that operate over scholarly search and document tools.", 2026, "preprint", "arXiv:2605.09104", "s2-agents", "https://arxiv.org/abs/2605.09104", "https://arxiv.org/pdf/2605.09104", "Read sections 4 and 6 next.", "inbox", 0, "venue-arxiv", "2026-07-07T16:48:00Z"],
  ],
  [
    `INSERT OR IGNORE INTO papers (id, title, abstract, year, paper_type, doi, semantic_scholar_id, url, notes, reading_status, favorite, venue_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["paper-memory", "Memory Architectures for Continual Scientific Discovery", "A perspective on episodic, semantic, and procedural memory for systems that support multi-month research programs.", 2025, "journal", "10.1038/pa.2025.812", "s2-memory", "https://www.nature.com/articles/pa-2025-812", "Connect to the lab notebook export design.", "reading", 0, "venue-nature", "2026-07-03T11:20:00Z"],
  ],
  [
    `INSERT OR IGNORE INTO papers (id, title, abstract, year, paper_type, preprint_id, semantic_scholar_id, url, pdf_url, notes, reading_status, favorite, venue_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["paper-graphs", "Scholarly Graphs as Navigable Research Context", "This work combines citation graphs, author entities, and venue priors into an interactive substrate for exploratory literature review.", 2024, "preprint", "arXiv:2409.11880", "s2-graphs", "https://arxiv.org/abs/2409.11880", "https://arxiv.org/pdf/2409.11880", "Potential foundation for author and venue views.", "complete", 0, "venue-arxiv", "2026-06-27T13:05:00Z"],
  ],
  ["INSERT OR IGNORE INTO paper_authors (paper_id, author_id, author_order, corresponding) VALUES (?, ?, ?, ?)", ["paper-retrieval", "author-amina", 0, 1]],
  ["INSERT OR IGNORE INTO paper_authors (paper_id, author_id, author_order, corresponding) VALUES (?, ?, ?, ?)", ["paper-retrieval", "author-theo", 1, 0]],
  ["INSERT OR IGNORE INTO paper_authors (paper_id, author_id, author_order, corresponding) VALUES (?, ?, ?, ?)", ["paper-sensemaking", "author-lena", 0, 1]],
  ["INSERT OR IGNORE INTO paper_authors (paper_id, author_id, author_order, corresponding) VALUES (?, ?, ?, ?)", ["paper-sensemaking", "author-amina", 1, 0]],
  ["INSERT OR IGNORE INTO paper_authors (paper_id, author_id, author_order, corresponding) VALUES (?, ?, ?, ?)", ["paper-agents", "author-sam", 0, 1]],
  ["INSERT OR IGNORE INTO paper_authors (paper_id, author_id, author_order, corresponding) VALUES (?, ?, ?, ?)", ["paper-agents", "author-yuki", 1, 0]],
  ["INSERT OR IGNORE INTO paper_authors (paper_id, author_id, author_order, corresponding) VALUES (?, ?, ?, ?)", ["paper-memory", "author-yuki", 0, 1]],
  ["INSERT OR IGNORE INTO paper_authors (paper_id, author_id, author_order, corresponding) VALUES (?, ?, ?, ?)", ["paper-memory", "author-sam", 1, 0]],
  ["INSERT OR IGNORE INTO paper_authors (paper_id, author_id, author_order, corresponding) VALUES (?, ?, ?, ?)", ["paper-graphs", "author-theo", 0, 1]],
  ["INSERT OR IGNORE INTO paper_authors (paper_id, author_id, author_order, corresponding) VALUES (?, ?, ?, ?)", ["paper-graphs", "author-lena", 1, 0]],
  ["INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)", ["collection-active", "Active review"]],
  ["INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)", ["collection-agents", "Research agents"]],
  ["INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)", ["collection-interface", "Interface patterns"]],
  ["INSERT OR IGNORE INTO paper_collections (paper_id, collection_id) VALUES (?, ?)", ["paper-retrieval", "collection-active"]],
  ["INSERT OR IGNORE INTO paper_collections (paper_id, collection_id) VALUES (?, ?)", ["paper-sensemaking", "collection-active"]],
  ["INSERT OR IGNORE INTO paper_collections (paper_id, collection_id) VALUES (?, ?)", ["paper-sensemaking", "collection-interface"]],
  ["INSERT OR IGNORE INTO paper_collections (paper_id, collection_id) VALUES (?, ?)", ["paper-agents", "collection-agents"]],
  ["INSERT OR IGNORE INTO paper_collections (paper_id, collection_id) VALUES (?, ?)", ["paper-graphs", "collection-interface"]],
] as const;

let initializationPromise: Promise<void> | null = null;

function getDatabase(): LibraryDb {
  ensureLibraryDirectories();
  return getLibraryDb(databasePath());
}

/**
 * Retire the ids inherited from the papercli import.
 *
 * "legacy-paper-85" looks like it means something and does not: it surfaces as a
 * proposal's target in the feed and inside the prompts the agent reads, where a
 * misleading name is worse than an opaque one. Rename those rows to the same
 * "<entity>-<uuid>" shape every record created since uses. The junction tables and
 * papers.venue_id all declare ON UPDATE CASCADE, so their references follow the
 * rename; the ids embedded in JSON columns (a queued proposal's operation, a
 * turn's attachments) are rewritten here, longest id first so "legacy-paper-1"
 * cannot eat the prefix of "legacy-paper-10".
 */
/**
 * Clear the subject class on every record that is not an arXiv paper. arXiv is the
 * one source in this app that assigns one: anything else either has no such concept
 * or names its own scheme, and the AI extractor used to fill the field with topic
 * labels of its own making ("AI for science"). Idempotent, so it also repairs a row
 * an older build wrote. Exported so the test drives this statement rather than a
 * second copy of it.
 */
export function sweepNonArxivCategories(raw: import("better-sqlite3").Database): void {
  raw
    .prepare(`UPDATE papers SET category = NULL WHERE category IS NOT NULL AND id NOT IN (
      SELECT p.id FROM papers p LEFT JOIN venues v ON v.id = p.venue_id
      WHERE lower(COALESCE(v.acronym, '')) LIKE 'arxiv%'
         OR lower(COALESCE(v.name, '')) LIKE 'arxiv%'
         OR lower(COALESCE(p.preprint_id, '')) LIKE 'arxiv%'
         OR lower(COALESCE(p.url, '')) LIKE '%//arxiv.org/%'
         OR lower(COALESCE(p.url, '')) LIKE '%.arxiv.org/%'
         OR lower(COALESCE(p.pdf_url, '')) LIKE '%//arxiv.org/%'
         OR lower(COALESCE(p.pdf_url, '')) LIKE '%.arxiv.org/%'
    )`)
    .run();
}

export function normalizeLegacyIds(raw: import("better-sqlite3").Database): void {
  const renames = new Map<string, string>();
  for (const [table, prefix] of [["papers", "paper"], ["authors", "author"], ["venues", "venue"], ["collections", "collection"]] as const) {
    const rows = raw.prepare(`SELECT id FROM ${table} WHERE id LIKE 'legacy-%'`).all() as Array<{ id: string }>;
    for (const row of rows) {
      renames.set(row.id, `${prefix}-${crypto.randomUUID()}`);
    }
  }
  if (!renames.size) {
    return;
  }
  const ordered = [...renames.entries()].sort(([left], [right]) => right.length - left.length);
  const rewrite = (value: string): string => {
    let next = value;
    for (const [from, to] of ordered) {
      if (next.includes(from)) next = next.split(from).join(to);
    }
    return next;
  };
  raw.transaction(() => {
    for (const [table, prefix] of [["papers", "paper"], ["authors", "author"], ["venues", "venue"], ["collections", "collection"]] as const) {
      const rows = raw.prepare(`SELECT id FROM ${table} WHERE id LIKE 'legacy-%'`).all() as Array<{ id: string }>;
      for (const row of rows) {
        const next = renames.get(row.id) ?? `${prefix}-${crypto.randomUUID()}`;
        raw.prepare(`UPDATE ${table} SET id = ? WHERE id = ?`).run(next, row.id);
      }
    }
    for (const [table, column] of [["feed_proposals", "operation"], ["feed_snippets", "attachments"], ["feed_messages", "attachments"]] as const) {
      const rows = raw
        .prepare(`SELECT rowid AS row, ${column} AS value FROM ${table} WHERE ${column} LIKE '%legacy-%'`)
        .all() as Array<{ row: number; value: string | null }>;
      for (const row of rows) {
        if (!row.value) continue;
        raw.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`).run(rewrite(row.value), row.row);
      }
    }
  })();
}

function tableColumns(raw: import("better-sqlite3").Database, table: string): Set<string> {
  const rows = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((column) => column.name));
}

async function initializeDatabase(): Promise<void> {
  // Schema creation, column migrations, and one-time seeding are DDL/bulk work
  // where Drizzle's query builder adds nothing; run them as raw SQL on the same
  // connection Drizzle owns. Application queries go through Drizzle (see the
  // library route). Everything here is synchronous better-sqlite3.
  const raw = getDatabase().$client;
  raw.pragma("foreign_keys = ON");

  for (const statement of schemaStatements) {
    raw.prepare(statement).run();
  }

  // The schema above is the authoritative, final shape; all historical column
  // migrations have been folded into the CREATE TABLE statements. Drop the
  // short-lived columns from the abandoned editable-note + prompt-chain-workflow
  // experiments, plus the never-used working_dir column (the runtime derives the
  // working directory from the snippet id instead), where they linger.
  const feedSnippetColumns = tableColumns(raw, "feed_snippets");
  if (feedSnippetColumns.has("note")) {
    raw.prepare("ALTER TABLE feed_snippets DROP COLUMN note").run();
  }
  if (feedSnippetColumns.has("workflow_steps")) {
    raw.prepare("ALTER TABLE feed_snippets DROP COLUMN workflow_steps").run();
  }
  if (feedSnippetColumns.has("working_dir")) {
    raw.prepare("ALTER TABLE feed_snippets DROP COLUMN working_dir").run();
  }
  // Add the collapse-feature columns to feeds created before it existed.
  if (!feedSnippetColumns.has("model")) {
    raw.prepare("ALTER TABLE feed_snippets ADD COLUMN model TEXT").run();
  }
  // Per-feed reasoning effort ("" / null = fall back to the global setting).
  if (!feedSnippetColumns.has("effort")) {
    raw.prepare("ALTER TABLE feed_snippets ADD COLUMN effort TEXT").run();
  }
  if (!feedSnippetColumns.has("history_mode")) {
    raw.prepare("ALTER TABLE feed_snippets ADD COLUMN history_mode TEXT").run();
  }
  if (!feedSnippetColumns.has("collapsed")) {
    raw.prepare("ALTER TABLE feed_snippets ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!feedSnippetColumns.has("issue_state_synced")) {
    raw.prepare("ALTER TABLE feed_snippets ADD COLUMN issue_state_synced TEXT").run();
  }
  // Track whether a message's attachments made it into its GitHub comment, so
  // sync stops probing old comments once backfill is done. Backfill defaults to
  // 0 (unknown) so pre-existing rows get (re)checked exactly once more.
  const feedMessageColumns = tableColumns(raw, "feed_messages");
  if (!feedMessageColumns.has("attachments_synced")) {
    raw.prepare("ALTER TABLE feed_messages ADD COLUMN attachments_synced INTEGER NOT NULL DEFAULT 0").run();
  }

  sweepNonArxivCategories(raw);

  normalizeLegacyIds(raw);

  const feedProposalColumns = tableColumns(raw, "feed_proposals");
  if (!feedProposalColumns.has("reported_at")) {
    raw.prepare("ALTER TABLE feed_proposals ADD COLUMN reported_at TEXT").run();
    // Decisions taken before this column existed count as already told: they were
    // carried by the reply prompts of the day, and dumping a library's whole
    // approval history into the next turn would be worse than saying nothing.
    raw
      .prepare("UPDATE feed_proposals SET reported_at = COALESCE(resolved_at, CURRENT_TIMESTAMP) WHERE status <> 'pending'")
      .run();
  }

  // Per-turn usage. Existing threads keep 0, so their replies simply show no
  // token or speed chip instead of a fabricated one.
  for (const column of ["input_tokens", "output_tokens", "duration_ms"]) {
    if (!feedMessageColumns.has(column)) {
      raw.prepare(`ALTER TABLE feed_messages ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`).run();
    }
  }

  // Consolidate the retired provider-specific arxiv_id into the one editable
  // preprint_id field, then remove the legacy column and index. Existing values
  // are never discarded when preprint_id is empty.
  const paperColumns = tableColumns(raw, "papers");
  if (!paperColumns.has("preprint_id")) {
    raw.prepare("ALTER TABLE papers ADD COLUMN preprint_id TEXT").run();
  }
  if (paperColumns.has("arxiv_id")) {
    raw.prepare(
      `UPDATE papers
       SET preprint_id = arxiv_id
       WHERE (preprint_id IS NULL OR TRIM(preprint_id) = '')
         AND arxiv_id IS NOT NULL AND TRIM(arxiv_id) != ''`,
    ).run();
    raw.prepare("DROP INDEX IF EXISTS papers_arxiv_id_unique").run();
    raw.prepare("ALTER TABLE papers DROP COLUMN arxiv_id").run();
  }

  // Canonicalize stored preprint identifiers (including historical arXiv URL,
  // prefix, and version variants) before adding the unique deduplication index.
  const preprintRows = raw.prepare(
    "SELECT id, preprint_id AS preprintId FROM papers WHERE preprint_id IS NOT NULL AND TRIM(preprint_id) != '' ORDER BY added_at, id",
  ).all() as Array<{ id: string; preprintId: string }>;
  const seenPreprintIds = new Set<string>();
  const writePreprintId = raw.prepare("UPDATE papers SET preprint_id = ? WHERE id = ?");
  for (const row of preprintRows) {
    const canonical = canonicalPreprintId(row.preprintId);
    const dedupKey = canonical?.toLowerCase() ?? null;
    if (!canonical || (dedupKey && seenPreprintIds.has(dedupKey))) {
      writePreprintId.run(null, row.id);
      continue;
    }
    seenPreprintIds.add(dedupKey!);
    if (canonical !== row.preprintId) writePreprintId.run(canonical, row.id);
  }

  // Enforce Preprint / Semantic Scholar id uniqueness (import dedup relies on it).
  // Created here, not in schemaStatements, because on an upgraded database the
  // CREATE UNIQUE INDEX fails if pre-existing rows already collide — so first
  // null out the duplicates (keep the earliest-added row for each id).
  for (const column of ["semantic_scholar_id"] as const) {
    raw.prepare(
      `UPDATE papers SET ${column} = NULL WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY ${column} ORDER BY added_at, id) AS rn
           FROM papers WHERE ${column} IS NOT NULL AND ${column} != ''
         ) WHERE rn > 1
       )`,
    ).run();
  }
  raw.prepare("CREATE UNIQUE INDEX IF NOT EXISTS papers_preprint_id_unique ON papers(preprint_id)").run();
  raw.prepare("CREATE UNIQUE INDEX IF NOT EXISTS papers_semantic_scholar_id_unique ON papers(semantic_scholar_id)").run();

  // One feed per GitHub issue. Unlink duplicate issue links (keep the earliest
  // feed) before creating the unique index, so an upgraded DB doesn't fail.
  raw.prepare(
    `UPDATE feed_snippets SET issue_number = NULL WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY issue_number ORDER BY created_at, id) AS rn
         FROM feed_snippets WHERE issue_number IS NOT NULL
       ) WHERE rn > 1
     )`,
  ).run();
  raw.prepare("CREATE UNIQUE INDEX IF NOT EXISTS feed_snippets_issue_number_unique ON feed_snippets(issue_number)").run();
  // Backfill a spread of accent colors onto any collections created before the
  // color column existed (deterministic from the id, so it never shifts).
  const uncolored = raw.prepare("SELECT id FROM collections WHERE color IS NULL").all() as Array<{ id: string }>;
  if (uncolored.length) {
    const palette = ["blue", "indigo", "violet", "pink", "rose", "orange", "amber", "lime", "green", "teal", "cyan", "slate"];
    const assign = raw.prepare("UPDATE collections SET color = ? WHERE id = ?");
    for (const { id } of uncolored) {
      let hash = 2166136261;
      for (let i = 0; i < id.length; i += 1) {
        hash ^= id.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      assign.run(palette[Math.abs(hash) % palette.length], id);
    }
  }

  // Seed the demo library exactly once, tracked by a persistent marker rather
  // than an empty papers table. Inferring "first run" from a zero row count
  // conflated it with "the user deleted every paper" and resurrected the demo
  // content on the next start. user_version 0 = never seeded; 1 = seeded.
  const seededVersion = Number((raw.pragma("user_version", { simple: true }) as number) ?? 0);
  const paperCount = raw.prepare("SELECT COUNT(*) AS count FROM papers").get() as { count: number };
  if (seededVersion === 0) {
    if (Number(paperCount?.count ?? 0) === 0) {
      const seed = raw.transaction(() => {
        for (const [statement, values] of seedStatements) {
          raw.prepare(statement).run(...values);
        }
      });
      seed();
    }
    // Mark as seeded whether or not we inserted, so an existing (non-empty)
    // library upgraded to this version is never treated as first-run either.
    raw.pragma("user_version = 1");
  }
}

export async function ensureDatabase(): Promise<LibraryDb> {
  if (!initializationPromise) {
    initializationPromise = initializeDatabase().catch((error) => {
      initializationPromise = null;
      throw error;
    });
    // Once, right after the first DB init: if OneDrive auto-backup is configured,
    // run a one-time backup so restart-time changes are protected and the sync
    // status reflects a real last-run time. Dynamically imported to keep the DB
    // layer decoupled from the settings/sync layer; best-effort (never blocks or
    // fails DB init).
    void initializationPromise
      .then(() => import("@/app/lib/local-settings"))
      .then((mod) => mod.syncOnStartup())
      .catch(() => {});
    // Also drain any GitHub actions queued while the app was closed (e.g. a feed
    // deleted offline needs its issue closed so sync doesn't recreate it).
    void initializationPromise
      .then(() => import("@/app/lib/feed-github-outbox"))
      .then((mod) => mod.flushGithubOutbox())
      .catch(() => {});
  }

  await initializationPromise;
  return getDatabase();
}
