/**
 * The library write contract. These run the real schema, so they fail if a rule
 * the module claims is not actually enforced.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { idList, LibraryMutationSchema } from "../../app/lib/schemas/library.ts";

/** Parse helper for the cases that are expected to succeed. */
function parse(input: unknown) {
  const result = LibraryMutationSchema.safeParse(input);
  assert.ok(result.success, `expected a valid mutation, got: ${result.success ? "" : result.error.message}`);
  return result.data;
}

/** The first issue message, for asserting on *why* something was refused. */
function firstIssue(input: unknown): string {
  const result = LibraryMutationSchema.safeParse(input);
  assert.ok(!result.success, "expected this mutation to be refused");
  return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

test("accepts each action's own shape", () => {
  for (const input of [
    { entity: "paper", action: "create", data: { title: "x" } },
    { entity: "author", action: "create" },
    { entity: "paper", action: "bulk-create", data: { papers: [{ title: "a" }] } },
    { entity: "paper", action: "update", id: "paper-1", data: { title: "y" } },
    { entity: "venue", action: "bulk-update", ids: ["v1", "v2"], data: { type: "journal" } },
    { entity: "paper", action: "delete", id: "paper-1" },
    { entity: "collection", action: "bulk-delete", ids: ["c1"] },
  ]) {
    assert.ok(LibraryMutationSchema.safeParse(input).success, `should accept ${JSON.stringify(input)}`);
  }
});

test("refuses a request with no recognizable action", () => {
  // The route used to answer these with a hand-written presence check; now the
  // discriminator does it, so an unknown action can't fall through every branch
  // and silently return an unchanged snapshot with a 200.
  assert.match(firstIssue({ entity: "paper", action: "remove" }), /action/);
  assert.match(firstIssue({ entity: "paper" }), /action/);
  assert.match(firstIssue({ action: "create" }), /entity/);
  assert.match(firstIssue({}), /action/);
  // Case matters: an LLM or a hand-rolled client sending "Create" is refused
  // rather than being treated as an unknown action later.
  assert.match(firstIssue({ entity: "paper", action: "Create" }), /action/);
});

test("refuses an entity outside the four record types", () => {
  assert.match(firstIssue({ entity: "papers", action: "create" }), /entity/);
  assert.match(firstIssue({ entity: "Paper", action: "create" }), /entity/);
  assert.match(firstIssue({ entity: "user", action: "delete", id: "u1" }), /entity/);
});

test("pins bulk-create to papers, with the 500-record cap at the boundary", () => {
  // The cap and the entity restriction used to be `if` statements in the route.
  // As schema rules they hold for every caller, including approved proposals.
  assert.match(firstIssue({ entity: "author", action: "bulk-create", data: { papers: [] } }), /paper/);
  assert.match(firstIssue({ entity: "paper", action: "bulk-create" }), /data/);
  assert.match(firstIssue({ entity: "paper", action: "bulk-create", data: {} }), /papers/);

  const atCap = { entity: "paper", action: "bulk-create", data: { papers: Array.from({ length: 500 }, () => ({})) } };
  assert.ok(LibraryMutationSchema.safeParse(atCap).success, "500 records is exactly at the cap and must pass");

  const overCap = { entity: "paper", action: "bulk-create", data: { papers: Array.from({ length: 501 }, () => ({})) } };
  assert.match(firstIssue(overCap), /500/);

  // An empty import is a no-op, not an error.
  assert.ok(LibraryMutationSchema.safeParse({ entity: "paper", action: "bulk-create", data: { papers: [] } }).success);
});

test("refuses an empty or blank record id", () => {
  // An empty id previously reached the DB layer as a WHERE that matched nothing,
  // reporting success for an update that changed no rows.
  assert.match(firstIssue({ entity: "paper", action: "update", id: "" }), /id/);
  assert.match(firstIssue({ entity: "paper", action: "delete", ids: [""] }), /ids/);
  assert.match(firstIssue({ entity: "paper", action: "delete", ids: "paper-1" }), /ids/);
});

test("idList reads a single id, an id array, and neither", () => {
  // Regression: a first implementation tested `"ids" in mutation` and returned
  // early, so a single `id` (what the UI sends for one-record edits) yielded an
  // empty list and every single-paper update silently became a no-op. Zod omits
  // absent optional keys, so each key has to be checked independently.
  assert.deepEqual(idList(parse({ entity: "paper", action: "update", id: "solo", data: {} })), ["solo"]);
  assert.deepEqual(idList(parse({ entity: "paper", action: "delete", ids: ["a", "b"] })), ["a", "b"]);
  // `ids` wins when both are present (the bulk path is the more specific one).
  assert.deepEqual(idList(parse({ entity: "paper", action: "delete", id: "x", ids: ["a"] })), ["a"]);
  // An empty array falls back to the single id rather than targeting nothing.
  assert.deepEqual(idList(parse({ entity: "paper", action: "delete", id: "fallback", ids: [] })), ["fallback"]);
  assert.deepEqual(idList(parse({ entity: "paper", action: "delete" })), []);
  // Branches that carry no id fields at all.
  assert.deepEqual(idList(parse({ entity: "paper", action: "create", data: {} })), []);
  assert.deepEqual(idList(parse({ entity: "paper", action: "bulk-create", data: { papers: [] } })), []);
});

test("keeps paper data open so normalization downstream still owns the fields", () => {
  // `data` is intentionally an open record: the library route normalizes titles,
  // author order, and page dashes, and accepts legacy field shapes. Validating
  // fields here would duplicate that logic and reject valid old records.
  const parsed = parse({
    entity: "paper",
    action: "create",
    data: { title: "x", year: "2026", authors: ["A", "B"], nested: { deep: [1, null] }, unknownField: true },
  });
  assert.ok("data" in parsed && parsed.data);
  assert.deepEqual(parsed.data?.authors, ["A", "B"]);
  assert.equal(parsed.data?.unknownField, true);
});

test("refuses a body that is not an object at all", () => {
  for (const input of [null, undefined, "create", 42, []]) {
    assert.ok(!LibraryMutationSchema.safeParse(input).success, `should refuse ${JSON.stringify(input)}`);
  }
});
