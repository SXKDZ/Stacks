/**
 * The agent-proposal boundary. This is the least-trusted input in the app: an
 * LLM composes the JSON, and anything accepted becomes a queued mutation on the
 * user's library, so these tests are written to fail against the plausible
 * weakenings (z.object instead of strictObject, dropping the id-per-action rule,
 * swallowing malformed entries).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentProposalOperationSchema,
  parseProposalBatch,
  ProposalEnvelopeSchema,
  ProposalOperationSchema,
  proposalSummary,
} from "../../app/lib/schemas/proposals.ts";

function issues(schema: typeof ProposalOperationSchema, input: unknown): string {
  const result = schema.safeParse(input);
  assert.ok(!result.success, `expected refusal for ${JSON.stringify(input)}`);
  return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

test("accepts the three canonical operations", () => {
  for (const input of [
    { entity: "paper", action: "create", data: { title: "x" } },
    { entity: "paper", action: "update", id: "paper-1", data: { year: 2026 } },
    { entity: "collection", action: "delete", id: "c1" },
    { entity: "author", action: "create", data: {}, summary: "add an author" },
  ]) {
    assert.ok(ProposalOperationSchema.safeParse(input).success, `should accept ${JSON.stringify(input)}`);
  }
});

test("rejects keys the contract does not define", () => {
  // strictObject is the point of this schema. A model that appends its own
  // fields, or a row written by a version that had a field since removed, must
  // fail rather than be accepted minus the part nobody read. Written with
  // z.object instead, every assertion here would pass.
  assert.match(issues(ProposalOperationSchema, { entity: "paper", action: "create", data: {}, confidence: 0.9 }), /confidence/);
  assert.match(issues(ProposalOperationSchema, { entity: "paper", action: "delete", id: "p1", reason: "duplicate" }), /reason/);
  assert.match(issues(ProposalOperationSchema, { entity: "paper", action: "create", data: {}, notes: null }), /notes/);
  // The lenient agent variant is lenient about missing fields, never about invented ones.
  assert.match(issues(AgentProposalOperationSchema, { entity: "paper", action: "create", confidence: 1 }), /confidence/);
});

test("requires an id exactly on the actions that act on an existing record", () => {
  // This is the invariant the discriminated union encodes: without it, an
  // applier could read operation.id on a create branch (undefined) or issue an
  // update with no target.
  assert.match(issues(ProposalOperationSchema, { entity: "paper", action: "update", data: {} }), /id/);
  assert.match(issues(ProposalOperationSchema, { entity: "paper", action: "delete" }), /id/);
  assert.match(issues(ProposalOperationSchema, { entity: "paper", action: "update", id: "", data: {} }), /id/);
  // A create carrying an id is refused rather than silently ignoring the field:
  // an agent sending one has misunderstood, and creating a record while
  // discarding the id it named would be the wrong recovery.
  assert.match(issues(ProposalOperationSchema, { entity: "paper", action: "create", id: "p1", data: {} }), /id/);
});

test("refuses a whitespace-only id and trims a real one", () => {
  // A whitespace id satisfies min(1) but matches no row, so the mutation would
  // run, change nothing, and still be recorded as applied: the user is told
  // their library changed when it did not. The id must therefore be trimmed
  // before the length check, not after.
  for (const id of ["", " ", "   ", "\t", "\n"]) {
    assert.ok(
      !ProposalOperationSchema.safeParse({ entity: "paper", action: "delete", id }).success,
      `should refuse id ${JSON.stringify(id)}`,
    );
    assert.ok(!AgentProposalOperationSchema.safeParse({ entity: "paper", action: "update", id, data: {} }).success);
  }
  // A real id surrounded by whitespace is usable, and is stored trimmed so it
  // matches the row it names.
  const padded = ProposalOperationSchema.safeParse({ entity: "paper", action: "delete", id: "  paper-1  " });
  assert.ok(padded.success);
  assert.equal(padded.data.action === "delete" ? padded.data.id : "", "paper-1");
});

test("refuses an action or entity outside the contract", () => {
  assert.match(issues(ProposalOperationSchema, { entity: "paper", action: "remove", id: "p1" }), /action/);
  assert.match(issues(ProposalOperationSchema, { entity: "paper", action: "CREATE", data: {} }), /action/);
  assert.match(issues(ProposalOperationSchema, { entity: "papers", action: "create", data: {} }), /entity/);
  assert.match(issues(ProposalOperationSchema, { entity: "paper", action: "create", data: {}, summary: 42 }), /summary/);
});

test("refuses data that is not an object", () => {
  for (const data of ["title", 42, null, [{ title: "x" }], true]) {
    assert.ok(
      !ProposalOperationSchema.safeParse({ entity: "paper", action: "create", data }).success,
      `should refuse data: ${JSON.stringify(data)}`,
    );
  }
  // Arbitrary nested values inside data are fine: the library route normalizes them.
  const deep = ProposalOperationSchema.safeParse({
    entity: "paper",
    action: "create",
    data: { title: "x", authors: ["a"], nested: { list: [1, null, { z: true }] } },
  });
  assert.ok(deep.success);
});

test("the lenient agent variant fills in only what a model reliably omits", () => {
  // Models routinely leave out data and summary. Structure is never relaxed.
  const created = AgentProposalOperationSchema.safeParse({ entity: "paper", action: "create" });
  assert.ok(created.success);
  assert.deepEqual(created.data.data, {}, "data must default to an empty record");

  const updated = AgentProposalOperationSchema.safeParse({ entity: "paper", action: "update", id: "p1" });
  assert.ok(updated.success);
  assert.deepEqual(updated.data.data, {});

  // Still structural: a missing id on update is refused by the lenient schema too.
  assert.ok(!AgentProposalOperationSchema.safeParse({ entity: "paper", action: "update" }).success);
  // The canonical schema does NOT accept a missing data (it is the stricter contract).
  assert.ok(!ProposalOperationSchema.safeParse({ entity: "paper", action: "create" }).success);
});

test("parseProposalBatch keeps the valid entries and reports the rest", () => {
  // The previous hand-written parser used a bare `continue`, so a malformed
  // proposal vanished: the agent claimed a change and no card appeared.
  const { operations, errors } = parseProposalBatch([
    { entity: "paper", action: "create", data: { title: "keep me" } },
    { entity: "paper", action: "update" },
    { entity: "nonsense", action: "create", data: {} },
    { entity: "collection", action: "delete", id: "c1" },
  ]);
  assert.equal(operations.length, 2, "both valid operations survive");
  assert.deepEqual(operations.map((op) => op.action), ["create", "delete"]);
  assert.equal(errors.length, 2, "both invalid entries are reported");
  // Errors name the position so a user or agent can tell which one failed.
  assert.match(errors[0], /proposal 2/);
  assert.match(errors[1], /proposal 3/);
});

test("parseProposalBatch accepts a single operation as well as an array", () => {
  const single = parseProposalBatch({ entity: "paper", action: "delete", id: "p1" });
  assert.equal(single.operations.length, 1);
  assert.deepEqual(single.errors, []);

  const bad = parseProposalBatch({ entity: "paper", action: "delete" });
  assert.equal(bad.operations.length, 0);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /id/);
});

test("parseProposalBatch handles empty and hostile input without throwing", () => {
  assert.deepEqual(parseProposalBatch([]), { operations: [], errors: [] });
  for (const input of [null, undefined, "", 0, "a string", [[]], [null]]) {
    const result = parseProposalBatch(input);
    assert.equal(result.operations.length, 0, `nothing valid in ${JSON.stringify(input)}`);
    assert.ok(result.errors.length >= 1, `a reason is reported for ${JSON.stringify(input)}`);
  }
});

test("a __proto__ key never reaches the parsed operation or the prototype", () => {
  // Worth pinning explicitly: strictObject does NOT report `__proto__` as an
  // unknown key (it isn't enumerated like a normal own property), so this does
  // not fail validation. What matters is the output, and Zod builds a fresh
  // object from the known keys only: the key is absent from the result, absent
  // from what gets persisted, and Object.prototype is untouched.
  const raw = JSON.parse('{"entity":"paper","action":"create","data":{},"__proto__":{"polluted":true}}');
  const result = ProposalOperationSchema.safeParse(raw);
  assert.ok(result.success);
  assert.deepEqual(Object.keys(result.data), ["entity", "action", "data"]);
  assert.equal(Object.prototype.hasOwnProperty.call(result.data, "__proto__"), false);
  assert.equal(JSON.stringify(result.data), '{"entity":"paper","action":"create","data":{}}');

  // Inside `data` it is carried as inert data (data is intentionally open).
  const withinData = ProposalOperationSchema.safeParse(
    JSON.parse('{"entity":"paper","action":"create","data":{"__proto__":{"polluted":true}}}'),
  );
  assert.ok(withinData.success);
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype must be untouched");
});

test("proposalSummary uses the agent's line or derives one", () => {
  assert.equal(
    proposalSummary({ entity: "paper", action: "create", data: {}, summary: "Add BERT" }),
    "Add BERT",
  );
  assert.equal(proposalSummary({ entity: "paper", action: "create", data: {} }), "create paper");
  assert.equal(proposalSummary({ entity: "collection", action: "delete", id: "c1" }), "delete collection");
});

test("the envelope accepts each wrapper the agent may post", () => {
  assert.ok(ProposalEnvelopeSchema.safeParse({ proposals: [{ entity: "paper", action: "create" }] }).success);
  assert.ok(ProposalEnvelopeSchema.safeParse({ operation: { entity: "paper", action: "create" } }).success);
  // Loose: the operation posted inline as the body still parses as an envelope,
  // and the route falls back to treating the whole body as the operation.
  assert.ok(ProposalEnvelopeSchema.safeParse({ entity: "paper", action: "create", data: {} }).success);
  assert.ok(!ProposalEnvelopeSchema.safeParse({ proposals: "not-an-array" }).success);
});
