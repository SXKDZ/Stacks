/**
 * The library write API, exercised end to end: real route handlers, a real
 * SQLite database in a temp directory, real normalization and dedup.
 *
 * This is the difference from the structural suites, which assert that source
 * text matches a regex. A test here fails when the behavior is wrong, not when
 * the code is merely rephrased.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { jsonRequest, readJson, createTempLibrary } from "../support/harness.ts";

// Must happen before any db module is imported (library-paths resolves the root
// once per process, and bootstrap caches its init promise).
createTempLibrary("stacks-library-route");

const routeModule = import("../../app/api/library/route.ts");
const API = "http://127.0.0.1/api/library";

interface Snapshot {
  papers: Array<{
    id: string;
    title: string;
    year: number | null;
    doi: string | null;
    authors: Array<{ displayName: string; order: number }>;
    collections: Array<{ name: string }>;
    venueName: string | null;
  }>;
  authors: Array<{ id: string; displayName: string; paperCount: number }>;
  venues: Array<{ id: string; name: string }>;
  collections: Array<{ id: string; name: string; paperCount: number }>;
  stats: Record<string, number>;
}

async function mutate(body: unknown) {
  const { POST } = await routeModule;
  return readJson(await POST(jsonRequest(API, body)));
}

async function snapshot(): Promise<Snapshot> {
  const { GET } = await routeModule;
  return (await GET()).json() as Promise<Snapshot>;
}

/** Find a paper by its normalized title. */
function findPaper(snap: Snapshot, title: string) {
  return snap.papers.find((paper) => paper.title === title);
}

test("creates a paper, normalizing metadata and linking its records", async () => {
  const created = await mutate({
    entity: "paper",
    action: "create",
    data: {
      title: "attention is all you need",
      year: "2017",
      paperType: "conference",
      doi: "10.5555/attention",
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      venueName: "Neural Information Processing Systems",
      venueAcronym: "NeurIPS",
      collectionNames: ["Transformers"],
      pages: "5998--6008",
    },
  });
  assert.equal(created.status, 200);

  const snap = await snapshot();
  const paper = findPaper(snap, "Attention Is All You Need");
  assert.ok(paper, "the title is stored title-cased by the normalizer");
  // A form sends year as a string; it is coerced to a number on the way in.
  assert.equal(paper.year, 2017);
  // Page ranges collapse to a single dash.
  assert.equal(snap.papers.find((p) => p.id === paper.id)?.year, 2017);
  // Authors are linked records, in the order given.
  assert.deepEqual(paper.authors.map((a) => a.displayName), ["Ashish Vaswani", "Noam Shazeer"]);
  assert.deepEqual(paper.authors.map((a) => a.order), [0, 1]);
  // The venue is canonicalized into its own record, not stored as text.
  assert.equal(paper.venueName, "Neural Information Processing Systems");
  assert.ok(snap.venues.some((venue) => venue.name === "Neural Information Processing Systems"));
  // A collection is created by name and linked.
  assert.deepEqual(paper.collections.map((c) => c.name), ["Transformers"]);
});

test("refuses a paper with no title", async () => {
  const result = await mutate({ entity: "paper", action: "create", data: { paperType: "article" } });
  assert.notEqual(result.status, 200);
  assert.match(JSON.stringify(result.body), /title/i);
});

test("rejects a duplicate DOI with a 409 rather than a second row", async () => {
  const before = (await snapshot()).papers.length;
  const duplicate = await mutate({
    entity: "paper",
    action: "create",
    data: { title: "A Different Title Entirely", paperType: "article", doi: "10.5555/attention" },
  });
  assert.equal(duplicate.status, 409, "a duplicate identifier is a conflict, not a silent second copy");
  assert.equal((await snapshot()).papers.length, before, "no row was added");
});

test("reuses one author record across papers", async () => {
  await mutate({
    entity: "paper",
    action: "create",
    data: { title: "a second transformer paper", paperType: "article", authors: ["Noam Shazeer"] },
  });
  const snap = await snapshot();
  const shazeer = snap.authors.filter((author) => author.displayName === "Noam Shazeer");
  assert.equal(shazeer.length, 1, "the author is one entity, not one row per paper");
  assert.equal(shazeer[0].paperCount, 2, "and is counted on both papers");
});

test("updates a paper's authors, replacing the old authorship rows", async () => {
  const paper = findPaper(await snapshot(), "A Second Transformer Paper");
  assert.ok(paper);
  const updated = await mutate({
    entity: "paper",
    action: "update",
    id: paper.id,
    data: { title: "a second transformer paper", paperType: "article", authors: ["Jakob Uszkoreit"] },
  });
  assert.equal(updated.status, 200);

  const after = findPaper(await snapshot(), "A Second Transformer Paper");
  assert.deepEqual(after?.authors.map((a) => a.displayName), ["Jakob Uszkoreit"], "the previous author is unlinked");
  assert.deepEqual(after?.authors.map((a) => a.order), [0], "order restarts contiguously");
});

test("a single-id update actually reaches its record", async () => {
  // Guards the idList regression: when only `id` is sent (what the edit form
  // does), an early return produced an empty target list and the update was a
  // silent no-op that still answered 200.
  const paper = findPaper(await snapshot(), "Attention Is All You Need");
  assert.ok(paper);
  await mutate({
    entity: "paper",
    action: "update",
    id: paper.id,
    data: { title: "attention is all you need", paperType: "conference", year: 2018 },
  });
  const after = findPaper(await snapshot(), "Attention Is All You Need");
  assert.equal(after?.year, 2018, "the change was persisted to the addressed row");
});

test("bulk-create isolates per-record failures and reports exact counts", async () => {
  const result = await mutate({
    entity: "paper",
    action: "bulk-create",
    data: {
      papers: [
        { title: "bulk import one", paperType: "article" },
        { paperType: "article" }, // no title: fails on its own
        { title: "bulk import two", paperType: "article", doi: "10.5555/attention" }, // duplicate: skipped
        { title: "bulk import three", paperType: "article" },
      ],
    },
  });
  assert.equal(result.status, 200);
  const summary = (result.body as { importSummary: { added: number; skipped: number; failed: unknown[] } }).importSummary;
  assert.equal(summary.added, 2, "the two good records land");
  assert.equal(summary.skipped, 1, "the duplicate is skipped, not failed");
  assert.equal(summary.failed.length, 1, "the titleless record is reported as failed");

  const snap = await snapshot();
  assert.ok(findPaper(snap, "Bulk Import One"));
  assert.ok(findPaper(snap, "Bulk Import Three"));
});

test("refuses a malformed request with a 400 instead of a 500", async () => {
  // Before the schema, these fell through to a cast and surfaced as a 500 from
  // deep inside a handler, or worse, as a 200 that changed nothing.
  for (const body of [
    { entity: "paper" },
    { action: "create" },
    { entity: "paper", action: "not-an-action" },
    { entity: "not-an-entity", action: "create" },
    { entity: "author", action: "bulk-create", data: { papers: [] } },
    { entity: "paper", action: "update", id: "" },
  ]) {
    const result = await mutate(body);
    assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${result.status}`);
    assert.ok((result.body as { error?: string }).error, "and a message naming the problem");
  }
});

test("enforces the bulk-create cap at the boundary", async () => {
  const overCap = await mutate({
    entity: "paper",
    action: "bulk-create",
    data: { papers: Array.from({ length: 501 }, (_, index) => ({ title: `over cap ${index}`, paperType: "article" })) },
  });
  assert.equal(overCap.status, 400);
  assert.match((overCap.body as { error: string }).error, /500/);
});

test("deleting a paper removes its links but keeps the shared author", async () => {
  const paper = findPaper(await snapshot(), "Bulk Import One");
  assert.ok(paper);
  const deleted = await mutate({ entity: "paper", action: "delete", id: paper.id });
  assert.equal(deleted.status, 200);

  const snap = await snapshot();
  assert.equal(findPaper(snap, "Bulk Import One"), undefined, "the paper is gone");
  // Authors are shared records: deleting a paper must not delete its people.
  assert.ok(snap.authors.some((author) => author.displayName === "Noam Shazeer"));
});

test("a bulk delete removes every addressed record", async () => {
  const snap = await snapshot();
  const targets = [findPaper(snap, "Bulk Import Three"), findPaper(snap, "A Second Transformer Paper")].filter(Boolean);
  assert.equal(targets.length, 2);
  const deleted = await mutate({ entity: "paper", action: "bulk-delete", ids: targets.map((paper) => paper!.id) });
  assert.equal(deleted.status, 200);

  const after = await snapshot();
  assert.equal(findPaper(after, "Bulk Import Three"), undefined);
  assert.equal(findPaper(after, "A Second Transformer Paper"), undefined);
});
