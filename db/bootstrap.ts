import { env } from "cloudflare:workers";

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
    citation_count INTEGER NOT NULL DEFAULT 0,
    venue_id TEXT REFERENCES venues(id) ON DELETE SET NULL ON UPDATE CASCADE,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS authors (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    given_name TEXT,
    family_name TEXT,
    affiliation TEXT,
    orcid TEXT UNIQUE,
    semantic_scholar_id TEXT,
    h_index INTEGER NOT NULL DEFAULT 0,
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
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT 'violet',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS paper_collections (
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY (paper_id, collection_id)
  )`,
  `CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT 'slate'
  )`,
  `CREATE TABLE IF NOT EXISTS paper_tags (
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY (paper_id, tag_id)
  )`,
  "CREATE INDEX IF NOT EXISTS papers_title_idx ON papers(title)",
  "CREATE INDEX IF NOT EXISTS papers_year_idx ON papers(year)",
  "CREATE INDEX IF NOT EXISTS papers_venue_idx ON papers(venue_id)",
  "CREATE INDEX IF NOT EXISTS authors_name_idx ON authors(display_name)",
  "CREATE INDEX IF NOT EXISTS paper_authors_author_idx ON paper_authors(author_id)",
];

const paperColumnUpgrades = [
  ["volume", "ALTER TABLE papers ADD COLUMN volume TEXT"],
  ["issue", "ALTER TABLE papers ADD COLUMN issue TEXT"],
  ["pages", "ALTER TABLE papers ADD COLUMN pages TEXT"],
  ["category", "ALTER TABLE papers ADD COLUMN category TEXT"],
  ["preprint_id", "ALTER TABLE papers ADD COLUMN preprint_id TEXT"],
  ["html_snapshot_path", "ALTER TABLE papers ADD COLUMN html_snapshot_path TEXT"],
  ["summary", "ALTER TABLE papers ADD COLUMN summary TEXT NOT NULL DEFAULT ''"],
] as const;

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
    `INSERT OR IGNORE INTO authors (id, display_name, given_name, family_name, affiliation, orcid, semantic_scholar_id, h_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["author-amina", "Amina Rahman", "Amina", "Rahman", "MIT CSAIL", "0000-0002-3141-5926", "s2-amina", 24],
  ],
  [
    `INSERT OR IGNORE INTO authors (id, display_name, given_name, family_name, affiliation, orcid, semantic_scholar_id, h_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["author-theo", "Theo Martins", "Theo", "Martins", "Stanford HAI", "0000-0001-7462-9012", "s2-theo", 18],
  ],
  [
    `INSERT OR IGNORE INTO authors (id, display_name, given_name, family_name, affiliation, orcid, semantic_scholar_id, h_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["author-yuki", "Yuki Tanaka", "Yuki", "Tanaka", "University of Tokyo", "0000-0003-8420-1187", "s2-yuki", 31],
  ],
  [
    `INSERT OR IGNORE INTO authors (id, display_name, given_name, family_name, affiliation, orcid, semantic_scholar_id, h_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["author-lena", "Lena Ortiz", "Lena", "Ortiz", "Carnegie Mellon University", "0000-0002-5579-2401", "s2-lena", 15],
  ],
  [
    `INSERT OR IGNORE INTO authors (id, display_name, given_name, family_name, affiliation, orcid, semantic_scholar_id, h_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["author-sam", "Samir Patel", "Samir", "Patel", "Google DeepMind", "0000-0001-6034-8752", "s2-samir", 42],
  ],
  [
    `INSERT OR IGNORE INTO papers (id, title, abstract, year, paper_type, doi, semantic_scholar_id, url, pdf_url, notes, reading_status, favorite, citation_count, venue_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["paper-retrieval", "Adaptive Retrieval for Long-Context Scientific Assistants", "We introduce a retrieval controller that learns when and where to search across long scientific documents, improving grounded question answering while reducing unnecessary context.", 2026, "conference", "10.5555/pa.2026.001", "s2-retrieval", "https://arxiv.org/abs/2602.01472", "https://arxiv.org/pdf/2602.01472", "Compare the ablation on retrieval depth with our literature graph baseline.", "reading", 1, 128, "venue-neurips", "2026-07-12T14:32:00Z"],
  ],
  [
    `INSERT OR IGNORE INTO papers (id, title, abstract, year, paper_type, doi, semantic_scholar_id, url, pdf_url, notes, reading_status, favorite, citation_count, venue_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["paper-sensemaking", "Interfaces for Human–AI Literature Sensemaking", "A mixed-methods study of interface patterns that help researchers synthesize unfamiliar literatures with generative AI while preserving provenance and agency.", 2025, "conference", "10.1145/pa.2025.014", "s2-sensemaking", "https://dl.acm.org/doi/10.1145/pa.2025.014", null, "Useful taxonomy for the related-work workspace.", "complete", 1, 76, "venue-chi", "2026-07-09T09:15:00Z"],
  ],
  [
    `INSERT OR IGNORE INTO papers (id, title, abstract, year, paper_type, arxiv_id, semantic_scholar_id, url, pdf_url, notes, reading_status, favorite, citation_count, venue_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["paper-agents", "Reliable Tool Use in Autonomous Research Agents", "We study failure recovery, verification, and cost-aware planning in autonomous agents that operate over scholarly search and document tools.", 2026, "preprint", "arXiv:2605.09104", "s2-agents", "https://arxiv.org/abs/2605.09104", "https://arxiv.org/pdf/2605.09104", "Read sections 4 and 6 next.", "inbox", 0, 34, "venue-arxiv", "2026-07-07T16:48:00Z"],
  ],
  [
    `INSERT OR IGNORE INTO papers (id, title, abstract, year, paper_type, doi, semantic_scholar_id, url, notes, reading_status, favorite, citation_count, venue_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["paper-memory", "Memory Architectures for Continual Scientific Discovery", "A perspective on episodic, semantic, and procedural memory for systems that support multi-month research programs.", 2025, "journal", "10.1038/pa.2025.812", "s2-memory", "https://www.nature.com/articles/pa-2025-812", "Connect to the lab notebook export design.", "reading", 0, 211, "venue-nature", "2026-07-03T11:20:00Z"],
  ],
  [
    `INSERT OR IGNORE INTO papers (id, title, abstract, year, paper_type, arxiv_id, semantic_scholar_id, url, pdf_url, notes, reading_status, favorite, citation_count, venue_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["paper-graphs", "Scholarly Graphs as Navigable Research Context", "This work combines citation graphs, author entities, and venue priors into an interactive substrate for exploratory literature review.", 2024, "preprint", "arXiv:2409.11880", "s2-graphs", "https://arxiv.org/abs/2409.11880", "https://arxiv.org/pdf/2409.11880", "Potential foundation for author and venue views.", "complete", 0, 93, "venue-arxiv", "2026-06-27T13:05:00Z"],
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
  ["INSERT OR IGNORE INTO collections (id, name, description, color) VALUES (?, ?, ?, ?)", ["collection-active", "Active review", "Papers in the current literature review.", "violet"]],
  ["INSERT OR IGNORE INTO collections (id, name, description, color) VALUES (?, ?, ?, ?)", ["collection-agents", "Research agents", "Agentic search, tools, and scientific workflows.", "cyan"]],
  ["INSERT OR IGNORE INTO collections (id, name, description, color) VALUES (?, ?, ?, ?)", ["collection-interface", "Interface patterns", "Human-centered tools for reading and synthesis.", "amber"]],
  ["INSERT OR IGNORE INTO paper_collections (paper_id, collection_id) VALUES (?, ?)", ["paper-retrieval", "collection-active"]],
  ["INSERT OR IGNORE INTO paper_collections (paper_id, collection_id) VALUES (?, ?)", ["paper-sensemaking", "collection-active"]],
  ["INSERT OR IGNORE INTO paper_collections (paper_id, collection_id) VALUES (?, ?)", ["paper-sensemaking", "collection-interface"]],
  ["INSERT OR IGNORE INTO paper_collections (paper_id, collection_id) VALUES (?, ?)", ["paper-agents", "collection-agents"]],
  ["INSERT OR IGNORE INTO paper_collections (paper_id, collection_id) VALUES (?, ?)", ["paper-graphs", "collection-interface"]],
] as const;

let initializationPromise: Promise<void> | null = null;

function getDatabase(): D1Database {
  if (!env.DB) {
    throw new Error("Paper Assistant requires the D1 binding named DB.");
  }
  return env.DB;
}

async function initializeDatabase(): Promise<void> {
  const database = getDatabase();
  await database.prepare("PRAGMA foreign_keys = ON").run();

  for (const statement of schemaStatements) {
    await database.prepare(statement).run();
  }

  const paperColumns = await database
    .prepare("PRAGMA table_info(papers)")
    .all<{ name: string }>();
  const existingPaperColumns = new Set(
    paperColumns.results.map((column) => column.name),
  );
  for (const [column, statement] of paperColumnUpgrades) {
    if (!existingPaperColumns.has(column)) {
      await database.prepare(statement).run();
    }
  }

  const preparedSeeds = seedStatements.map(([statement, values]) => {
    return database.prepare(statement).bind(...values);
  });
  await database.batch(preparedSeeds);
}

export async function ensureDatabase(): Promise<D1Database> {
  if (!initializationPromise) {
    initializationPromise = initializeDatabase().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }

  await initializationPromise;
  return getDatabase();
}
