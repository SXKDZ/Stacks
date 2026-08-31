/**
 * The subject class is an arXiv-only field.
 *
 * The column holds the class a source assigns (cs.LG). arXiv is the only source in
 * this app that assigns one, so a value on anything else is either a topic label a
 * model invented or a class from a scheme the app does not track. The rule is
 * enforced on write and swept at startup, so this test drives the sweep on a real
 * SQLite file rather than asserting on the SQL text.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { sweepNonArxivCategories } from "../../db/bootstrap.ts";

test("the startup sweep keeps a class on arXiv records and clears it everywhere else", () => {
  const root = mkdtempSync(join(tmpdir(), "stacks-arxiv-category-"));
  const database = new Database(join(root, "library.db"));
  try {
    database.exec(`
      CREATE TABLE venues (id TEXT PRIMARY KEY, name TEXT, acronym TEXT);
      CREATE TABLE papers (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT,
        preprint_id TEXT,
        url TEXT,
        pdf_url TEXT,
        venue_id TEXT REFERENCES venues(id)
      );
      INSERT INTO venues VALUES ('v-arxiv', 'arXiv', 'arXiv'), ('v-icml', 'International Conference on Machine Learning', 'ICML'), ('v-biorxiv', 'bioRxiv', 'bioRxiv');
      -- Kept: named by venue, by acronym, by preprint id, by link.
      INSERT INTO papers VALUES ('keep-venue', 'By venue', 'cs.LG', NULL, NULL, NULL, 'v-arxiv');
      INSERT INTO papers VALUES ('keep-preprint', 'By preprint id', 'stat.ML', 'arXiv 2401.00001', NULL, NULL, 'v-icml');
      INSERT INTO papers VALUES ('keep-url', 'By link', 'cs.CL', NULL, 'https://arxiv.org/abs/2401.00002', NULL, NULL);
      INSERT INTO papers VALUES ('keep-pdf', 'By pdf link', 'cs.AI', NULL, NULL, 'https://arxiv.org/pdf/2401.00003', NULL);
      -- Cleared: a conference paper with an invented topic, a bioRxiv class, and a
      -- record with no venue at all.
      INSERT INTO papers VALUES ('clear-icml', 'Invented topic', 'AI for science', NULL, NULL, NULL, 'v-icml');
      INSERT INTO papers VALUES ('clear-biorxiv', 'Other preprint scheme', 'q-bio', '10.1101/2026.06.29', NULL, NULL, 'v-biorxiv');
      INSERT INTO papers VALUES ('clear-bare', 'No venue', 'Machine Learning', NULL, NULL, NULL, NULL);
      -- A lookalike host must not count as arXiv.
      INSERT INTO papers VALUES ('clear-lookalike', 'Lookalike host', 'cs.LG', NULL, 'https://notarxiv.org/abs/1', NULL, NULL);
    `);

    sweepNonArxivCategories(database);

    const rows = database.prepare("SELECT id, category FROM papers ORDER BY id").all() as Array<{ id: string; category: string | null }>;
    const byId = new Map(rows.map((row) => [row.id, row.category]));
    assert.equal(byId.get("keep-venue"), "cs.LG");
    assert.equal(byId.get("keep-preprint"), "stat.ML");
    assert.equal(byId.get("keep-url"), "cs.CL");
    assert.equal(byId.get("keep-pdf"), "cs.AI");
    assert.equal(byId.get("clear-icml"), null);
    assert.equal(byId.get("clear-biorxiv"), null);
    assert.equal(byId.get("clear-bare"), null);
    assert.equal(byId.get("clear-lookalike"), null);

    // Idempotent: a second run leaves every row exactly as the first did.
    sweepNonArxivCategories(database);
    const after = database.prepare("SELECT id, category FROM papers ORDER BY id").all();
    assert.deepEqual(after, rows);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
