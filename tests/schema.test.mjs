import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("normalizes authors and venues as first-class linked records", async () => {
  const [schema, authorMigration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0002_bumpy_arachne.sql", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /export const authors = sqliteTable/);
  assert.match(schema, /export const venues = sqliteTable/);
  assert.match(schema, /export const paperAuthors = sqliteTable/);
  assert.match(schema, /authorOrder/);
  assert.match(schema, /onDelete: "set null"/);
  assert.match(schema, /onUpdate: "cascade"/);
  assert.doesNotMatch(schema, /email:/);
  assert.match(authorMigration, /DROP COLUMN `email`/);
});

test("keeps API credentials out of tracked examples", async () => {
  const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(example, /your_serpapi_key/);
  assert.match(example, /your_bedrock_api_key/);
  assert.doesNotMatch(example, /ABSKQ|jina_[a-z0-9]{20,}|s2k-/i);
});

test("persists local settings atomically and provides dependency-free PA sync", async () => {
  const [plugin, bridge, example, ignore] = await Promise.all([
    readFile(new URL("../build/papercli-settings-plugin.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/papercli_sync_bridge.py", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);
  assert.match(plugin, /api\/local-settings/);
  assert.match(plugin, /api\/local-runtime-settings/);
  assert.match(plugin, /api\/local-sync/);
  assert.match(plugin, /api\/local-directory-picker/);
  assert.match(plugin, /settings\.json\.tmp/);
  assert.match(plugin, /renameSync\(settingsTemporaryPath, settingsPath\)/);
  assert.doesNotMatch(plugin, /writeFileSync\(environmentPath/);
  assert.match(bridge, /papercli_sync\.lock/);
  assert.match(bridge, /html_snapshots/);
  assert.match(example, /PAPERCLI_REMOTE_PATH/);
  assert.match(example, /PA_MAX_TOKENS/);
  assert.match(ignore, /data\/settings\.json/);
});

test("discovers and tests current Bedrock Runtime and Mantle models", async () => {
  const [models, bedrock, prompts] = await Promise.all([
    readFile(new URL("../app/api/models/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/bedrock.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/ai-prompts.ts", import.meta.url), "utf8"),
  ]);
  assert.match(models, /bedrock-mantle/);
  assert.match(models, /inference-profiles/);
  assert.match(bedrock, /anthropic\/v1\/messages/);
  assert.match(bedrock, /\/converse/);
  assert.match(prompts, /\{\{papers\}\}/);
  assert.match(prompts, /\{\{paper1\}\}/);
});

test("supports provider search and PA-style identifier imports", async () => {
  const [discover, identifier, scholarly] = await Promise.all([
    readFile(new URL("../app/api/discover/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/import-identifier/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/scholarly.ts", import.meta.url), "utf8"),
  ]);
  assert.match(discover, /searchProvider/);
  assert.match(identifier, /importIdentifier/);
  assert.match(scholarly, /searchSemanticScholar/);
  assert.match(scholarly, /searchGoogleScholar/);
  assert.match(scholarly, /searchArxiv/);
  assert.match(scholarly, /searchDblp/);
  assert.match(scholarly, /searchCrossref/);
  assert.match(scholarly, /importDoi/);
  assert.match(scholarly, /importDblp/);
  assert.match(scholarly, /importOpenReview/);
});

test("uses integrated sortable table headers without a detached sort control", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/PaperAssistant.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(component, /SortablePaperHeader/);
  assert.match(component, /aria-sort/);
  assert.doesNotMatch(component, /SORT\s*<\/span>/);
  assert.match(styles, /\.table-sort-button/);
  assert.match(styles, /\.library-toolbar/);
});
