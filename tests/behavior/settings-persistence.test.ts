/**
 * Settings persistence and the managed-storage guards.
 *
 * These run against a real temp library, because the failures are about what
 * survives a write: a stamp silently dropped by an unrelated save forces a full
 * re-sync, and a path check that accepts ".." reports files outside the library.
 */
import assert from "node:assert/strict";
import test from "node:test";

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
