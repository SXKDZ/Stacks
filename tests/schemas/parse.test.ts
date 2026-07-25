/**
 * The parse helpers, plus the two deliberately-tolerant list schemas.
 *
 * The helpers are the app's only path from untrusted bytes to typed data, so the
 * contract that matters is: never throw, and always say why.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { describeZodError, parseJsonWith, parseRequest, parseWith } from "../../app/lib/schemas/parse.ts";
import { SnippetAttachmentListSchema } from "../../app/lib/schemas/attachments.ts";
import { normalizeSkillList } from "../../app/lib/schemas/feed-skills.ts";

const Person = z.object({ name: z.string(), age: z.number() });

test("parseWith returns typed data or a readable reason", () => {
  const good = parseWith(Person, { name: "Ada", age: 36 });
  assert.ok(good.ok);
  assert.equal(good.data.name, "Ada");

  const bad = parseWith(Person, { name: "Ada" });
  assert.ok(!bad.ok);
  assert.match(bad.error, /age/);
});

test("parseJsonWith folds syntax errors and shape errors into one outcome", () => {
  const good = parseJsonWith(Person, '{"name":"Ada","age":36}');
  assert.ok(good.ok);
  assert.equal(good.data.age, 36);

  // Malformed JSON: reported, never thrown.
  const syntax = parseJsonWith(Person, "{not json");
  assert.ok(!syntax.ok);
  assert.ok(syntax.error.length > 0);

  // Valid JSON of the wrong shape.
  const shape = parseJsonWith(Person, '{"name":"Ada","age":"36"}');
  assert.ok(!shape.ok);
  assert.match(shape.error, /age/);

  // Empty and whitespace input are failures, not crashes.
  for (const text of ["", "   ", "null", "[]"]) {
    assert.equal(parseJsonWith(Person, text).ok, false, `should refuse ${JSON.stringify(text)}`);
  }
});

test("describeZodError names nested paths and root-level problems", () => {
  const nested = z.object({ data: z.object({ papers: z.array(z.number()) }) });
  const result = nested.safeParse({ data: { papers: [1, "two"] } });
  assert.ok(!result.success);
  // The path pinpoints the offending element, which is what makes a 400 useful.
  assert.match(describeZodError(result.error), /data\.papers\.1/);

  // A root-level failure has an empty path and must still read as a sentence.
  const root = z.string().safeParse(42);
  assert.ok(!root.success);
  const described = describeZodError(root.error);
  assert.ok(described.length > 0);
  assert.equal(described.startsWith(":"), false, "an empty path must not leave a leading colon");
});

test("parseRequest reads a JSON body and refuses anything else", async () => {
  const ok = await parseRequest(
    Person,
    new Request("http://127.0.0.1/x", { method: "POST", body: JSON.stringify({ name: "Ada", age: 36 }), headers: { "Content-Type": "application/json" } }),
  );
  assert.ok(ok.ok);

  // Not JSON at all: a clear instruction rather than a thrown SyntaxError that
  // the route would answer as a 500.
  const notJson = await parseRequest(Person, new Request("http://127.0.0.1/x", { method: "POST", body: "plain text" }));
  assert.ok(!notJson.ok);
  assert.match(notJson.error, /JSON/i);

  // An empty body is the same class of failure.
  const empty = await parseRequest(Person, new Request("http://127.0.0.1/x", { method: "POST" }));
  assert.ok(!empty.ok);

  // JSON of the wrong shape names the field.
  const wrong = await parseRequest(
    Person,
    new Request("http://127.0.0.1/x", { method: "POST", body: JSON.stringify({ name: 1 }), headers: { "Content-Type": "application/json" } }),
  );
  assert.ok(!wrong.ok);
  assert.match(wrong.error, /name/);
});

test("an attachment list drops only the broken entries", () => {
  // One malformed row must not blank out a turn's other attachments.
  const parsed = SnippetAttachmentListSchema.safeParse([
    { kind: "upload", label: "notes.txt", relativePath: "attachments/notes.txt" },
    { kind: "nonsense", label: "bad" },
    { label: "missing kind" },
    { kind: "paper", label: "Attention Is All You Need", paperId: "paper-1" },
  ]);
  assert.ok(parsed.success);
  assert.equal(parsed.data.length, 2);
  assert.deepEqual(parsed.data.map((a) => a.kind), ["upload", "paper"]);
});

test("legacy attachment kinds still validate", () => {
  // Old feeds copied papers in; those rows are still on disk and must render.
  const parsed = SnippetAttachmentListSchema.safeParse([
    { kind: "paper-pdf", label: "old.pdf", relativePath: "attachments/old.pdf" },
    { kind: "paper-html", label: "old.html", relativePath: "attachments/old.html" },
  ]);
  assert.ok(parsed.success);
  assert.equal(parsed.data.length, 2);
});

test("a non-array attachments value is refused outright", () => {
  for (const input of [null, {}, "attachments", 5]) {
    assert.equal(SnippetAttachmentListSchema.safeParse(input).success, false, `should refuse ${JSON.stringify(input)}`);
  }
  const empty = SnippetAttachmentListSchema.safeParse([]);
  assert.ok(empty.success);
  assert.deepEqual(empty.data, []);
});

test("skill normalization coerces, caps, and skips the unusable", () => {
  const known = (name: string) => name === "sparkles" || name === "summarize";

  assert.equal(normalizeSkillList("not an array", known, "sparkles"), null, "a non-array signals 'use defaults'");

  const skills = normalizeSkillList(
    [
      { id: " keep-me ", label: "  Summarize  ", icon: "summarize", prompt: "  do it  " },
      { label: "No Id Here", icon: "unknown-icon", prompt: "still fine" },
      { label: "   ", prompt: "blank label" },
      { label: "blank prompt", prompt: "   " },
      "not an object",
      null,
    ],
    known,
    "sparkles",
  );
  assert.ok(skills);
  assert.equal(skills.length, 2, "the two unusable entries and the two non-objects are skipped");

  // Trimming, and an explicit id is kept.
  assert.equal(skills[0].id, "keep-me");
  assert.equal(skills[0].label, "Summarize");
  assert.equal(skills[0].prompt, "do it");

  // A missing id is derived from the label; an unknown icon falls back.
  assert.equal(skills[1].id, "skill-1-no-id-here");
  assert.equal(skills[1].icon, "sparkles");
});

test("skill text is capped exactly at the stored limits", () => {
  const known = () => true;
  const atLimit = normalizeSkillList(
    [{ label: "L".repeat(60), prompt: "P".repeat(4000), icon: "x" }],
    known,
    "sparkles",
  );
  assert.ok(atLimit);
  assert.equal(atLimit[0].label.length, 60, "exactly at the cap is kept whole");
  assert.equal(atLimit[0].prompt.length, 4000);

  const overLimit = normalizeSkillList(
    [{ label: "L".repeat(61), prompt: "P".repeat(4001), icon: "x" }],
    known,
    "sparkles",
  );
  assert.ok(overLimit);
  assert.equal(overLimit[0].label.length, 60, "one over is truncated");
  assert.equal(overLimit[0].prompt.length, 4000);
});
