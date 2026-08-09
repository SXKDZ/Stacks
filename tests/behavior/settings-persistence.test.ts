/**
 * Settings persistence and the managed-storage guards.
 *
 * These run against a real temp library, because the failures are about what
 * survives a write: a stamp silently dropped by an unrelated save forces a full
 * re-sync, and a path check that accepts ".." reports files outside the library.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { createTempLibrary } from "../support/harness.ts";

createTempLibrary("stacks-settings-persistence");

const settings = import("../../app/lib/local-settings.ts");
const localFiles = import("../../app/lib/local-files.ts");

test("an unrelated save keeps the GitHub sync high-water mark", async () => {
  // Dropping it forced sync to re-read every issue and comment in the repo.
  const api = await settings;
  api.persistSettings({ githubRepo: "owner/repo" });
  api.writeGithubLastSyncedAt("2026-07-25T00:00:00Z");
  api.writeGithubLinkedRepo("owner/repo");

  api.persistSettings({ modelId: "some-model" });
  assert.equal(api.readGithubLastSyncedAt(), "2026-07-25T00:00:00Z");
  assert.equal(api.readGithubLinkedRepo(), "owner/repo");

  // Saving the same repo again is also not a change.
  api.persistSettings({ githubRepo: "owner/repo" });
  assert.equal(api.readGithubLastSyncedAt(), "2026-07-25T00:00:00Z");
});

test("changing the repo clears the mark, since it belongs to the old timeline", async () => {
  const api = await settings;
  api.persistSettings({ githubRepo: "owner/different" });
  assert.equal(api.readGithubLastSyncedAt(), undefined);
  // linkedRepo is deliberately kept: it is how sync knows the links are stale.
  assert.equal(api.readGithubLinkedRepo(), "owner/repo");
});

test("secrets survive an unrelated save and are not echoed back", async () => {
  const api = await settings;
  api.persistSettings({ secrets: { GITHUB_TOKEN: "tok-123" } });
  api.persistSettings({ modelId: "another-model" });
  // The value is still usable by the server...
  assert.equal(api.runtimeValues().GITHUB_TOKEN, "tok-123");
  // ...but currentSettings must not hand it back to the client.
  assert.equal(JSON.stringify(api.currentSettings()).includes("tok-123"), false);
});

test("storedFileExists only answers for a bare name inside the managed directory", async () => {
  const api = await localFiles;
  // A traversal must never be reported as present: a stale path in a paper row
  // would otherwise claim a file outside the library is ours.
  for (const name of ["..", ".", "../../etc/passwd", "sub/dir.pdf", "/etc/passwd"]) {
    assert.equal(api.storedFileExists("pdf", name), false, `${name} must not be reported`);
  }
  assert.equal(api.storedFileExists("pdf", null), false);
  assert.equal(api.storedFileExists("pdf", "not-there.pdf"), false);
});

test("the temperature switch survives a save and reaches the AI routes", async () => {
  // This setting has to be listed in three separate places to work: the
  // environmentKeys allowlist (or the write is silently dropped), the runtimeKeys
  // list (or the AI routes read the default instead of the saved value), and the
  // structuredValue map. Missing either of the first two produced a switch that
  // looked saved in the UI but changed nothing about the request, which is exactly
  // how it shipped broken twice while being developed.
  const api = await settings;

  api.persistSettings({ sendTemperature: false });
  assert.equal(api.currentSettings().ai.sendTemperature, false, "the saved value must be read back");
  assert.equal(
    api.runtimeValues().STACKS_SEND_TEMPERATURE,
    "false",
    "the AI routes read runtimeValues(), so the switch must appear there too",
  );

  api.persistSettings({ sendTemperature: true });
  assert.equal(api.currentSettings().ai.sendTemperature, true);
  assert.equal(api.runtimeValues().STACKS_SEND_TEMPERATURE, "true");

  // An unrelated save must not reset it: `false` is a real value, not "unset".
  api.persistSettings({ sendTemperature: false });
  api.persistSettings({ maxTokens: 4096 });
  assert.equal(api.currentSettings().ai.sendTemperature, false, "an omitted field keeps its saved value");
});

test("temperatureOption omits the parameter only when the switch is off", async () => {
  // Bedrock rejects an explicit null/undefined differently from an absent key, so
  // the request builder keys off undefined to drop it entirely.
  const { temperatureOption } = await import("../../app/lib/bedrock.ts");
  assert.equal(temperatureOption(false, 0.5), undefined, "off means the key is not sent at all");
  assert.equal(temperatureOption(true, 0.5), 0.5);
  // Clamped into the range Bedrock accepts.
  assert.equal(temperatureOption(true, 2), 1);
  assert.equal(temperatureOption(true, -1), 0);
  // Zero is a legitimate temperature, not "unset".
  assert.equal(temperatureOption(true, 0), 0);
});

test("every runtime setting is writable and readable, with no key half-registered", () => {
  // The bug this guards: writable keys, runtime keys, and secrets used to be three
  // hand-maintained lists that all had to agree, and nothing checked that they did.
  // A key present in only some of them saved in the UI while changing nothing about
  // the request it controlled. They are now derived from one table; this asserts the
  // derivation holds, so the lists cannot drift apart again.
  const source = readFileSync(new URL("../../app/lib/local-settings.ts", import.meta.url), "utf8");
  const table = /const SETTING_KEYS = \{([\s\S]*?)\n\} as const/.exec(source);
  assert.ok(table, "SETTING_KEYS must remain the single declaration of setting keys");

  const declared = [...table[1].matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*\{([^}]*)\}/gm)]
    .map(([, key, flags]) => ({ key, runtime: flags.includes("runtime") }));
  assert.ok(declared.length >= 15, `expected the full key table, parsed ${declared.length}`);

  // Each key must have a mapping onto the settings file. A missing one reads as
  // permanently unset; the typed Record in structuredValue makes it a compile
  // error, and this catches it if that annotation is ever loosened.
  const mapping = /const values: Record<SettingKey, string \| undefined> = \{([\s\S]*?)\n  \};/.exec(source);
  assert.ok(mapping, "structuredValue must map every key");
  for (const { key } of declared) {
    assert.match(mapping[1], new RegExp(`\\b${key}:`), `${key} has no structuredValue mapping`);
  }

  // The three lists are derived, not restated: no second literal list of keys.
  assert.ok(!/const runtimeKeys = \[\s*"/.test(source), "runtimeKeys must be derived from SETTING_KEYS");
  assert.ok(!/const environmentKeys = new Set\(\[\s*"/.test(source), "environmentKeys must be derived from SETTING_KEYS");
});

test("a runtime setting survives a save and is exposed to the AI routes", async () => {
  const api = await settings;
  // Every key flagged `runtime` must appear in runtimeValues() once it has a value,
  // because that is the only channel the AI routes read.
  api.persistSettings({ modelId: "us.anthropic.claude-opus-5", sendTemperature: false });
  const values = api.runtimeValues();
  for (const key of ["BEDROCK_MODEL_ID", "STACKS_SEND_TEMPERATURE"]) {
    assert.ok(key in values, `${key} is a runtime key but never reached runtimeValues()`);
  }
  assert.equal(values.STACKS_SEND_TEMPERATURE, "false");
  assert.equal(values.BEDROCK_MODEL_ID, "us.anthropic.claude-opus-5");
  // A local-only key stays out: runtimeValues is what the AI routes read, and the
  // OneDrive path is not theirs to see.
  api.persistSettings({ remotePath: "/tmp/stacks-backup" });
  assert.ok(!("STACKS_ONEDRIVE_PATH" in api.runtimeValues()), "a non-runtime key must not leak into runtimeValues()");
});

test("the global reasoning effort persists and reaches the AI routes", async () => {
  const api = await settings;
  api.persistSettings({ effort: "high" });
  assert.equal(api.currentSettings().ai.effort, "high");
  assert.equal(api.runtimeValues().STACKS_EFFORT, "high", "the AI routes read runtimeValues()");

  // An unrecognised level is stored as unset rather than persisted: Bedrock 400s on
  // a variant it does not know, so a bad value must not survive a write.
  api.persistSettings({ effort: "turbo" });
  assert.equal(api.currentSettings().ai.effort, "");

  // Explicitly clearing it is a legitimate save, not an omitted field.
  api.persistSettings({ effort: "max" });
  api.persistSettings({ effort: "" });
  assert.equal(api.currentSettings().ai.effort, "");

  // An unrelated save keeps it.
  api.persistSettings({ effort: "medium" });
  api.persistSettings({ maxTokens: 4096 });
  assert.equal(api.currentSettings().ai.effort, "medium");
});

test("the AI feed turn limit persists, reaches the runner, and supports unlimited", async () => {
  const api = await settings;

  api.persistSettings({ feedMaxTurns: 80 });
  assert.equal(api.currentSettings().ai.feedMaxTurns, 80);
  assert.equal(api.runtimeValues().STACKS_FEED_MAX_TURNS, "80");

  api.persistSettings({ feedMaxTurns: 0 });
  assert.equal(api.currentSettings().ai.feedMaxTurns, 0, "zero is the explicit unlimited value");
  assert.equal(api.runtimeValues().STACKS_FEED_MAX_TURNS, "0");

  api.persistSettings({ modelId: "another-model" });
  assert.equal(api.currentSettings().ai.feedMaxTurns, 0, "an unrelated save keeps unlimited mode");
});
