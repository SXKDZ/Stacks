/**
 * Retiring the papercli ids.
 *
 * This migration renames primary keys in a library that is already in use, so the
 * test exercises the real thing on a real SQLite file: the references in the
 * junction tables have to follow the rename (they declare ON UPDATE CASCADE), and
 * the ids embedded in a queued proposal's JSON have to be rewritten, or approving
 * that proposal after the rename would target a record that no longer exists.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { normalizeLegacyIds } from "../../db/bootstrap.ts";

function seed() {
  const root = mkdtempSync(join(tmpdir(), "stacks-legacy-ids-"));
  const database = new Database(join(root, "library.db"));
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE venues (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE papers (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      venue_id TEXT REFERENCES venues(id) ON DELETE SET NULL ON UPDATE CASCADE
    );
    CREATE TABLE authors (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
    CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE paper_authors (
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
      author_id TEXT NOT NULL REFERENCES authors(id) ON DELETE CASCADE ON UPDATE CASCADE,
      PRIMARY KEY (paper_id, author_id)
    );
    CREATE TABLE paper_collections (
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE ON UPDATE CASCADE,
      PRIMARY KEY (paper_id, collection_id)
    );
    CREATE TABLE feed_proposals (id TEXT PRIMARY KEY, operation TEXT NOT NULL);
    CREATE TABLE feed_snippets (id TEXT PRIMARY KEY, attachments TEXT);
    CREATE TABLE feed_messages (id TEXT PRIMARY KEY, attachments TEXT);

    INSERT INTO venues VALUES ('legacy-venue-3', 'NeurIPS');
    INSERT INTO papers VALUES ('legacy-paper-1', 'One', 'legacy-venue-3');
    INSERT INTO papers VALUES ('legacy-paper-10', 'Ten', NULL);
    INSERT INTO papers VALUES ('paper-keep', 'Already normalized', NULL);
    INSERT INTO authors VALUES ('legacy-author-7', 'A. Author');
    INSERT INTO collections VALUES ('legacy-collection-59', 'Understanding');
    INSERT INTO paper_authors VALUES ('legacy-paper-1', 'legacy-author-7');
    INSERT INTO paper_collections VALUES ('legacy-paper-10', 'legacy-collection-59');
    INSERT INTO feed_proposals VALUES ('prop-1', '{"entity":"collection","action":"update","id":"legacy-collection-59","data":{"addPaperIds":["legacy-paper-1","legacy-paper-10"]}}');
    INSERT INTO feed_snippets VALUES ('feed-1', '[{"kind":"paper","paperId":"legacy-paper-10","label":"Ten"}]');
    INSERT INTO feed_messages VALUES ('msg-1', NULL);
  `);
  return { root, database };
}

test("legacy ids are renamed, and every reference to them follows", () => {
  const { root, database } = seed();
  try {
    normalizeLegacyIds(database);

    const legacyCount = (table: string) =>
      (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE id LIKE 'legacy-%'`).get() as { count: number }).count;
    for (const table of ["papers", "authors", "venues", "collections"]) {
      assert.equal(legacyCount(table), 0, `${table} still has a papercli id`);
    }
    // Renamed, not deleted, and to the app's own "<entity>-<uuid>" shape.
    const papers = database.prepare("SELECT id, title, venue_id FROM papers ORDER BY title").all() as Array<{ id: string; title: string; venue_id: string | null }>;
    assert.deepEqual(papers.map((paper) => paper.title), ["Already normalized", "One", "Ten"]);
    const one = papers.find((paper) => paper.title === "One")!;
    const ten = papers.find((paper) => paper.title === "Ten")!;
    assert.match(one.id, /^paper-[0-9a-f-]{36}$/);
    assert.equal(papers.find((paper) => paper.title === "Already normalized")!.id, "paper-keep");

    // The junction rows point at the new ids (ON UPDATE CASCADE), not at nothing.
    const link = database.prepare("SELECT paper_id, author_id FROM paper_authors").get() as { paper_id: string; author_id: string };
    const author = database.prepare("SELECT id FROM authors").get() as { id: string };
    assert.equal(link.paper_id, one.id);
    assert.equal(link.author_id, author.id);
    const membership = database.prepare("SELECT paper_id, collection_id FROM paper_collections").get() as { paper_id: string; collection_id: string };
    const collection = database.prepare("SELECT id FROM collections").get() as { id: string };
    assert.equal(membership.paper_id, ten.id);
    assert.equal(membership.collection_id, collection.id);
    // The venue reference on the paper followed its rename too.
    const venue = database.prepare("SELECT id FROM venues").get() as { id: string };
    assert.equal(one.venue_id, venue.id);

    // A queued proposal now targets the renamed records. "legacy-paper-1" must not
    // have eaten the prefix of "legacy-paper-10" while rewriting.
    const proposal = JSON.parse((database.prepare("SELECT operation FROM feed_proposals").get() as { operation: string }).operation);
    assert.equal(proposal.id, collection.id);
    assert.deepEqual(proposal.data.addPaperIds, [one.id, ten.id]);
    const attachments = JSON.parse((database.prepare("SELECT attachments FROM feed_snippets").get() as { attachments: string }).attachments);
    assert.equal(attachments[0].paperId, ten.id);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a library with no papercli ids is left alone", () => {
  const root = mkdtempSync(join(tmpdir(), "stacks-legacy-ids-"));
  const database = new Database(join(root, "library.db"));
  try {
    database.exec(`
      CREATE TABLE venues (id TEXT PRIMARY KEY);
      CREATE TABLE papers (id TEXT PRIMARY KEY, venue_id TEXT);
      CREATE TABLE authors (id TEXT PRIMARY KEY);
      CREATE TABLE collections (id TEXT PRIMARY KEY);
      CREATE TABLE feed_proposals (id TEXT PRIMARY KEY, operation TEXT NOT NULL);
      CREATE TABLE feed_snippets (id TEXT PRIMARY KEY, attachments TEXT);
      CREATE TABLE feed_messages (id TEXT PRIMARY KEY, attachments TEXT);
      INSERT INTO papers VALUES ('paper-abc', NULL);
      INSERT INTO feed_proposals VALUES ('prop-1', '{"id":"paper-abc"}');
    `);
    normalizeLegacyIds(database);
    assert.equal((database.prepare("SELECT id FROM papers").get() as { id: string }).id, "paper-abc");
    assert.equal((database.prepare("SELECT operation FROM feed_proposals").get() as { operation: string }).operation, '{"id":"paper-abc"}');
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
