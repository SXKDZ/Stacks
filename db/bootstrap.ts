import { databasePath, ensureLibraryDirectories } from "./library-paths";
import { getLibraryDb, type LibraryDb } from "./client";

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
    arxiv_id TEXT,
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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS papers_title_idx ON papers(title)",
  "CREATE INDEX IF NOT EXISTS papers_year_idx ON papers(year)",
  "CREATE INDEX IF NOT EXISTS papers_venue_idx ON papers(venue_id)",
  "CREATE INDEX IF NOT EXISTS authors_name_idx ON authors(display_name)",
  "CREATE INDEX IF NOT EXISTS paper_authors_author_idx ON paper_authors(author_id)",
  "CREATE INDEX IF NOT EXISTS feed_snippets_updated_idx ON feed_snippets(updated_at)",
  "CREATE INDEX IF NOT EXISTS feed_messages_snippet_idx ON feed_messages(snippet_id, created_at)",
  "CREATE INDEX IF NOT EXISTS feed_proposals_snippet_idx ON feed_proposals(snippet_id)",
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
    `INSERT OR IGNORE INTO papers (id, title, abstract, year, paper_type, arxiv_id, semantic_scholar_id, url, pdf_url, notes, reading_status, favorite, venue_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["paper-agents", "Reliable Tool Use in Autonomous Research Agents", "We study failure recovery, verification, and cost-aware planning in autonomous agents that operate over scholarly search and document tools.", 2026, "preprint", "arXiv:2605.09104", "s2-agents", "https://arxiv.org/abs/2605.09104", "https://arxiv.org/pdf/2605.09104", "Read sections 4 and 6 next.", "inbox", 0, "venue-arxiv", "2026-07-07T16:48:00Z"],
  ],
  [
    `INSERT OR IGNORE INTO papers (id, title, abstract, year, paper_type, doi, semantic_scholar_id, url, notes, reading_status, favorite, venue_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["paper-memory", "Memory Architectures for Continual Scientific Discovery", "A perspective on episodic, semantic, and procedural memory for systems that support multi-month research programs.", 2025, "journal", "10.1038/pa.2025.812", "s2-memory", "https://www.nature.com/articles/pa-2025-812", "Connect to the lab notebook export design.", "reading", 0, "venue-nature", "2026-07-03T11:20:00Z"],
  ],
  [
    `INSERT OR IGNORE INTO papers (id, title, abstract, year, paper_type, arxiv_id, semantic_scholar_id, url, pdf_url, notes, reading_status, favorite, venue_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  if (!feedSnippetColumns.has("collapsed")) {
    raw.prepare("ALTER TABLE feed_snippets ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!feedSnippetColumns.has("issue_state_synced")) {
    raw.prepare("ALTER TABLE feed_snippets ADD COLUMN issue_state_synced TEXT").run();
  }
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

  const paperCount = raw.prepare("SELECT COUNT(*) AS count FROM papers").get() as { count: number };
  if (Number(paperCount?.count ?? 0) === 0) {
    const seed = raw.transaction(() => {
      for (const [statement, values] of seedStatements) {
        raw.prepare(statement).run(...values);
      }
    });
    seed();
  }
}

export async function ensureDatabase(): Promise<LibraryDb> {
  if (!initializationPromise) {
    initializationPromise = initializeDatabase().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }

  await initializationPromise;
  return getDatabase();
}
