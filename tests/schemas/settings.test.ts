/**
 * The settings.json boundary. A bad value here becomes a request parameter to
 * Bedrock or a path the sync bridge writes to, so the read has to refuse a file
 * it doesn't understand instead of passing pieces of it along.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  SettingsPayloadSchema,
  StructuredSettingsFileSchema,
  SyncResultSchema,
} from "../../app/lib/schemas/settings.ts";

/** A minimal file that satisfies the schema, for targeted mutation per test. */
function validFile() {
  return {
    version: 1,
    updatedAt: "2026-07-25T00:00:00.000Z",
    ai: { modelId: "us.anthropic.claude-sonnet-4-6", region: "us-east-1", maxTokens: "10000", temperature: "0.25" },
    prompts: { extractionSystem: "extract", summarySystem: "summarize" },
    sync: { remotePath: "", autoSync: "false", autoSyncInterval: "5" },
    secrets: {},
  };
}

test("accepts a complete settings file", () => {
  assert.ok(StructuredSettingsFileSchema.safeParse(validFile()).success);
});

test("treats an unrecognized schema version as unreadable", () => {
  // The version is a literal so a file from a future (or ancient) shape is
  // rejected wholesale rather than read with today's assumptions.
  for (const version of [2, 0, "1", null, undefined]) {
    const file = { ...validFile(), version };
    assert.ok(!StructuredSettingsFileSchema.safeParse(file).success, `version ${JSON.stringify(version)} must be refused`);
  }
});

test("requires each nested config block", () => {
  for (const key of ["ai", "prompts", "sync", "secrets"] as const) {
    const file = validFile();
    delete (file as Record<string, unknown>)[key];
    assert.ok(!StructuredSettingsFileSchema.safeParse(file).success, `a file missing ${key} must be refused`);
  }
});

test("refuses a wrong-typed value inside a block", () => {
  // The concrete motivation: maxTokens is stored as a string and passed into the
  // Bedrock request. A number (or anything else) here used to flow straight
  // through the cast and fail at the API instead of at the read.
  const numeric = validFile();
  (numeric.ai as Record<string, unknown>).maxTokens = 10000;
  assert.ok(!StructuredSettingsFileSchema.safeParse(numeric).success);

  const missingField = validFile();
  delete (missingField.ai as Record<string, unknown>).region;
  assert.ok(!StructuredSettingsFileSchema.safeParse(missingField).success);

  const badSecret = validFile();
  (badSecret.secrets as Record<string, unknown>).GITHUB_TOKEN = 12345;
  assert.ok(!StructuredSettingsFileSchema.safeParse(badSecret).success, "secrets must be strings");
});

test("github block is optional but needs a repo when present", () => {
  assert.ok(StructuredSettingsFileSchema.safeParse(validFile()).success, "absent github is fine");

  const withRepo = { ...validFile(), github: { repo: "owner/name" } };
  assert.ok(StructuredSettingsFileSchema.safeParse(withRepo).success);

  const full = { ...validFile(), github: { repo: "owner/name", lastSyncedAt: "2026-07-25T00:00:00Z", linkedRepo: "owner/name" } };
  assert.ok(StructuredSettingsFileSchema.safeParse(full).success);

  const noRepo = { ...validFile(), github: { lastSyncedAt: "2026-07-25T00:00:00Z" } };
  assert.ok(!StructuredSettingsFileSchema.safeParse(noRepo).success, "a github block without a repo is incoherent");
});

test("drops unknown top-level keys instead of failing the read", () => {
  // Deliberate: a settings file written by a NEWER version may carry keys this
  // version doesn't know. Failing would reset the user's whole configuration, so
  // unknown keys are ignored while the known ones are still validated.
  const parsed = StructuredSettingsFileSchema.safeParse({ ...validFile(), somethingNew: { nested: true } });
  assert.ok(parsed.success);
  assert.equal("somethingNew" in parsed.data, false, "the unknown key is not carried forward");
});

test("refuses malformed feed skill and workflow entries", () => {
  const badSkill = { ...validFile(), feedSkills: [{ id: "s1", label: "x" }] };
  assert.ok(!StructuredSettingsFileSchema.safeParse(badSkill).success, "a skill missing icon/prompt is refused");

  const goodSkill = { ...validFile(), feedSkills: [{ id: "s1", label: "x", icon: "sparkles", prompt: "do it" }] };
  assert.ok(StructuredSettingsFileSchema.safeParse(goodSkill).success);

  const badWorkflow = { ...validFile(), feedWorkflows: [{ id: "w1", name: "n" }] };
  assert.ok(!StructuredSettingsFileSchema.safeParse(badWorkflow).success);
});

test("the posted payload accepts numbers where the file stores strings", () => {
  // A number input in the settings form yields a number; the file stores strings.
  // The payload schema is the place that tolerates both.
  const numeric = SettingsPayloadSchema.safeParse({ maxTokens: 8000, temperature: 0.5, autoSyncInterval: 10 });
  assert.ok(numeric.success);
  assert.equal(numeric.data.maxTokens, 8000);

  const stringly = SettingsPayloadSchema.safeParse({ maxTokens: "8000", temperature: "0.5", autoSyncInterval: "10" });
  assert.ok(stringly.success);

  // autoSync is a real boolean on the wire (a checkbox), a string in the file.
  assert.ok(SettingsPayloadSchema.safeParse({ autoSync: true }).success);
  assert.ok(!SettingsPayloadSchema.safeParse({ autoSync: "true" }).success);

  // Every field is optional: the form saves one section at a time.
  assert.ok(SettingsPayloadSchema.safeParse({}).success);
  // A wrong type is still refused.
  assert.ok(!SettingsPayloadSchema.safeParse({ modelId: 42 }).success);
  assert.ok(!SettingsPayloadSchema.safeParse({ secrets: { GITHUB_TOKEN: 1 } }).success);
});

test("the sync bridge result is validated as a whole", () => {
  // A separate Python process writes this, so its shape can drift independently
  // of any TypeScript change; a partial line used to read as an empty summary.
  const result = {
    ok: true,
    summary: "Backed up 5 papers",
    changes: { papers: 5 },
    details: { papers: ["a", "b"] },
    conflicts: 0,
    errors: [],
    cancelled: false,
    progress: [{ message: "copying" }],
    logs: [{ action: "copy", details: "library.db" }],
  };
  assert.ok(SyncResultSchema.safeParse(result).success);

  // A truncated or partial object is refused rather than yielding a blank summary.
  assert.ok(!SyncResultSchema.safeParse({ ok: true }).success);
  assert.ok(!SyncResultSchema.safeParse({}).success);
  const wrongCounts = { ...result, changes: { papers: "5" } };
  assert.ok(!SyncResultSchema.safeParse(wrongCounts).success, "counts must be numbers");
  // Extra fields from a newer bridge are tolerated.
  assert.ok(SyncResultSchema.safeParse({ ...result, newField: 1 }).success);
});
