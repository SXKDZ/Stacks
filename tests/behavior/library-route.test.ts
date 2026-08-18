/**
 * The library write API, exercised end to end: real route handlers, a real
 * SQLite database in a temp directory, real normalization and dedup.
 *
 * This is the difference from the structural suites, which assert that source
 * text matches a regex. A test here fails when the behavior is wrong, not when
 * the code is merely rephrased.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { jsonRequest, readJson, createTempLibrary } from "../support/harness.ts";

// Must happen before any db module is imported (library-paths resolves the root
// once per process, and bootstrap caches its init promise).
const libraryRoot = createTempLibrary("stacks-library-route");

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
    localFilePath: string | null;
    htmlFilePath: string | null;
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
      localPath: "attention.pdf",
      htmlSnapshotPath: "attention.html",
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
  // The UI keeps the portable filenames for storage operations, but receives the
  // full locations for useful file tooltips.
  assert.equal(paper.localFilePath, join(libraryRoot, "pdfs", "attention.pdf"));
  assert.equal(paper.htmlFilePath, join(libraryRoot, "html_snapshots", "attention.html"));
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

test("a bulk update writes every addressed paper, not just the first", async () => {
  // A bulk-update of N ids used to call updatePaper(ids[0]) once and answer 200,
  // so the other N-1 papers were silently left untouched.
  await mutate({ entity: "paper", action: "create", data: { title: "bulk target one", paperType: "article" } });
  await mutate({ entity: "paper", action: "create", data: { title: "bulk target two", paperType: "article" } });
  const snap = await snapshot();
  const targets = [findPaper(snap, "Bulk Target One"), findPaper(snap, "Bulk Target Two")];
  assert.ok(targets[0] && targets[1]);

  const result = await mutate({
    entity: "paper",
    action: "bulk-update",
    ids: targets.map((paper) => paper!.id),
    data: { readingStatus: "complete" },
  });
  assert.equal(result.status, 200);

  const after = await snapshot();
  for (const title of ["Bulk Target One", "Bulk Target Two"]) {
    const paper = after.papers.find((candidate) => candidate.title === title) as { readingStatus?: string } | undefined;
    assert.equal(paper?.readingStatus, "complete", `${title} should have been updated`);
  }
});

test("a string 'false' does not star a paper", async () => {
  // Boolean("false") is true, so an importer or agent sending the string form
  // used to star the paper it meant to leave alone.
  await mutate({ entity: "paper", action: "create", data: { title: "not starred", paperType: "article", favorite: "false" } });
  await mutate({ entity: "paper", action: "create", data: { title: "also not starred", paperType: "article", favorite: "0" } });
  await mutate({ entity: "paper", action: "create", data: { title: "really starred", paperType: "article", favorite: "true" } });
  const snap = await snapshot() as unknown as { papers: Array<{ title: string; favorite: boolean }> };
  assert.equal(snap.papers.find((p) => p.title === "Not Starred")?.favorite, false);
  assert.equal(snap.papers.find((p) => p.title === "Also Not Starred")?.favorite, false);
  assert.equal(snap.papers.find((p) => p.title === "Really Starred")?.favorite, true);
});

test("a year is stored as a plausible whole number or not at all", async () => {
  // The column is INTEGER but SQLite is dynamically typed, so a fractional value
  // was stored as REAL (2026.7) and 1e21 in exponent form, both of which then sort
  // and display as nonsense.
  const cases: Array<[string, unknown, number | null]> = [
    ["year fractional", 2026.7, 2026],
    ["year huge", 1e21, null],
    ["year negative", -500, null],
    ["year normal", 2024, 2024],
    ["year as text", "2023", 2023],
  ];
  for (const [title, input] of cases) {
    await mutate({ entity: "paper", action: "create", data: { title, paperType: "article", year: input } });
  }
  const snap = await snapshot();
  for (const [title, , expected] of cases) {
    const stored = snap.papers.find((paper) => paper.title.toLowerCase() === title.toLowerCase());
    assert.equal(stored?.year ?? null, expected, `${title} should store ${expected}`);
  }
});

test("non-name author entries never become author records", async () => {
  // String(entry) turned an object into the author "[object Object]", a number into
  // "42", and null into "null", each inserted as a permanent shared record.
  await mutate({
    entity: "paper",
    action: "create",
    data: {
      title: "mixed author payload",
      paperType: "article",
      authors: [{ name: "Ada Lovelace" }, 42, null, "Real Person", ""],
    },
  });
  const snap = await snapshot();
  const names = snap.authors.map((author) => author.displayName);
  assert.ok(names.includes("Ada Lovelace"), "a structured entry's name is read");
  assert.ok(names.includes("Real Person"));
  for (const junk of ["[object Object]", "42", "null", "undefined"]) {
    assert.equal(names.includes(junk), false, `${junk} must never be an author`);
  }
});

test("control characters are stripped from stored text", async () => {
  // A NUL byte reached SQLite raw, where C-string tooling sees a truncated title.
  const withNul = `Robust${String.fromCharCode(0)} Title`;
  await mutate({ entity: "paper", action: "create", data: { title: withNul, paperType: "article" } });
  const snap = await snapshot();
  const stored = snap.papers.find((paper) => paper.title.startsWith("Robust"));
  assert.ok(stored, "the paper is stored");
  assert.equal([...stored.title].some((char) => char.charCodeAt(0) === 0), false, "no NUL survives");
});

test("updating a paper that does not exist is refused, and creates nothing", async () => {
  // The UPDATE matched no rows and still committed, so the route answered 200 for an
  // edit that changed nothing while creating the venue named in the payload.
  const before = await snapshot();
  const result = await mutate({
    entity: "paper",
    action: "update",
    id: "paper-does-not-exist",
    data: { title: "ghost", paperType: "article", venueName: "Phantom Venue" },
  });
  assert.equal(result.status, 400);
  const after = await snapshot();
  assert.equal(after.venues.some((venue) => venue.name === "Phantom Venue"), false, "no orphan venue");
  assert.equal(after.papers.length, before.papers.length);
});

test("renaming a record to whitespace is refused", async () => {
  // The name identifies the record everywhere in the UI; createEntity enforced
  // this and the update path did not, so a record could be left unnameable.
  const snap = await snapshot();
  const author = snap.authors[0];
  assert.ok(author);
  const blank = await mutate({ entity: "author", action: "update", id: author.id, data: { displayName: "   " } });
  assert.equal(blank.status, 400);
  assert.equal(
    (await snapshot()).authors.find((candidate) => candidate.id === author.id)?.displayName,
    author.displayName,
    "the existing name is untouched",
  );
  // A real rename still works.
  const renamed = await mutate({ entity: "author", action: "update", id: author.id, data: { displayName: "Renamed Author" } });
  assert.equal(renamed.status, 200);
  assert.equal(
    (await snapshot()).authors.find((candidate) => candidate.id === author.id)?.displayName,
    "Renamed Author",
  );
});

test("a payload of only prototype keys writes no column", async () => {
  // `key in fields` walks the prototype chain, so toString/constructor/valueOf all
  // passed the guard and were written as columns.
  const snap = await snapshot();
  const venue = snap.venues[0];
  assert.ok(venue);
  const result = await mutate({
    entity: "venue",
    action: "update",
    id: venue.id,
    data: { toString: "x", constructor: "y", valueOf: "z", hasOwnProperty: "w" },
  });
  assert.equal(result.status, 200, "the request is harmless, just empty");
  const after = (await snapshot()).venues.find((candidate) => candidate.id === venue.id);
  assert.equal(after?.name, venue.name, "nothing about the record changed");
});

test("identifier dedup catches the format variants the app's own sources emit", async () => {
  // Stored data can use an arXiv prefix, providers write the bare id, and a
  // BibTeX import can carry a full URL with a version suffix. Dedup compared the
  // column exactly, so the same paper from two sources became two rows.
  const before = (await snapshot()).papers.length;
  const first = await mutate({
    entity: "paper",
    action: "create",
    data: { title: "dedup target", paperType: "preprint", preprintId: "arXiv:2605.19104" },
  });
  assert.equal(first.status, 200);
  for (const variant of ["2605.19104", "https://arxiv.org/abs/2605.19104v2", "ARXIV:2605.19104"]) {
    const duplicate = await mutate({
      entity: "paper",
      action: "create",
      data: { title: `dedup variant ${variant}`, paperType: "preprint", preprintId: variant },
    });
    assert.equal(duplicate.status, 409, `${variant} is the same paper`);
  }
  assert.equal((await snapshot()).papers.length, before + 1, "exactly one row was added");
});

test("a DOI is compared case-insensitively and without its resolver prefix", async () => {
  // DOIs are case-insensitive by spec, so "10.1000/ABC" and "10.1000/abc" are the
  // same paper, as is the doi.org URL form.
  const before = (await snapshot()).papers.length;
  assert.equal(
    (await mutate({ entity: "paper", action: "create", data: { title: "doi target", paperType: "article", doi: "10.5555/MixedCase" } })).status,
    200,
  );
  for (const variant of ["10.5555/mixedcase", "https://doi.org/10.5555/MIXEDCASE", "doi:10.5555/mixedcase"]) {
    assert.equal(
      (await mutate({ entity: "paper", action: "create", data: { title: `doi ${variant}`, paperType: "article", doi: variant } })).status,
      409,
      `${variant} is the same DOI`,
    );
  }
  assert.equal((await snapshot()).papers.length, before + 1);
});
