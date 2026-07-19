import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readApplicationStyles } from "./read-application-styles.mjs";

const execFile = promisify(execFileCallback);

test("normalizes authors and venues as first-class linked records", async () => {
  const [schema, authorMigration, uiAlignmentMigration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0002_bumpy_arachne.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0004_broken_blacklash.sql", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /export const authors = sqliteTable/);
  assert.match(schema, /export const venues = sqliteTable/);
  assert.match(schema, /export const paperAuthors = sqliteTable/);
  assert.match(schema, /authorOrder/);
  assert.match(schema, /onDelete: "set null"/);
  assert.match(schema, /onUpdate: "cascade"/);
  assert.doesNotMatch(schema, /email:/);
  assert.doesNotMatch(schema, /affiliation:|hIndex:|citationCount:/);
  assert.match(authorMigration, /DROP COLUMN `email`/);
  assert.match(uiAlignmentMigration, /DROP COLUMN `affiliation`/);
  assert.match(uiAlignmentMigration, /DROP COLUMN `h_index`/);
  assert.match(uiAlignmentMigration, /DROP COLUMN `citation_count`/);
});

test("keeps API credentials out of tracked examples", async () => {
  const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(example, /your_serpapi_key/);
  assert.match(example, /your_bedrock_api_key/);
  assert.doesNotMatch(example, /ABSKQ|jina_[a-z0-9]{20,}|s2k-/i);
});

test("persists local settings atomically and backs up the normalized library", async () => {
  const [settings, routeSettings, routeRuntime, routeSync, routePicker, bridge, example, ignore] = await Promise.all([
    readFile(new URL("../app/lib/local-settings.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/local-settings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/local-runtime-settings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/local-sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/local-directory-picker/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/pa_sync_bridge.py", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);
  // Local settings are served by real Next routes (Node runtime), backed by the
  // self-contained library folder via db/library-paths.
  assert.match(routeSettings, /export const runtime = "nodejs"/);
  assert.match(routeRuntime, /x-pa-internal-runtime/);
  assert.match(routeSync, /export async function POST/);
  assert.match(routePicker, /chooseDirectory/);
  assert.match(settings, /settingsPath\(\)/);
  assert.match(settings, /databasePath\(\)/);
  assert.match(settings, /"local" \| "remote" \| "storage"/);
  // Atomic write: temp file + rename.
  assert.match(settings, /settings\.json\.tmp/);
  assert.match(settings, /renameSync\(temporaryPath, path\)/);
  assert.match(bridge, /pa_sync\.lock/);
  assert.match(bridge, /html_snapshots/);
  assert.match(example, /PA_ONEDRIVE_PATH/);
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

test("ships deployed settings, database Doctor, PDF grounding, and update checks", async () => {
  const [bootstrap, settingsRoute, settingsStore, doctor, chat, grounding, settingsView, version] = await Promise.all([
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/settings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/settings-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/storage-management/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/document-grounding.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SettingsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/version/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(bootstrap, /CREATE TABLE IF NOT EXISTS app_settings/);
  assert.match(settingsRoute, /saveStoredSettings/);
  assert.doesNotMatch(settingsRoute, /501|Not implemented/i);
  assert.match(settingsStore, /Preferences use D1|app_settings/);
  assert.match(doctor, /PRAGMA quick_check/);
  assert.match(doctor, /PRAGMA foreign_key_check/);
  assert.match(doctor, /orphanedAssociations/);
  assert.match(chat, /PA_PDF_PAGES/);
  assert.match(chat, /pdfStartPage/);
  assert.match(grounding, /getDocumentProxy/);
  assert.match(grounding, /redirect: "manual"/);
  assert.match(settingsView, /PDF grounding pages/);
  assert.match(settingsView, /About & updates/);
  assert.match(version, /releases\/latest/);
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

test("imports BibTeX and RIS files into normalized paper records", async () => {
  const [route, parser, library, application] = await Promise.all([
    readFile(new URL("../app/api/import-bibliography/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/bibliography.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/library/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PaperAssistant.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /parseBibliography/);
  assert.match(parser, /parseBibtex/);
  assert.match(parser, /parseRis/);
  assert.match(parser, /parseBibAuthors/);
  assert.match(library, /bulk-create/);
  assert.match(application, /BibTeX \/ RIS/);
  assert.match(application, /import-bibliography/);
  assert.doesNotMatch(application, /BibTeX, RIS, and local PDF imports remain available through the companion CLI/);
});

test("persists collection membership through the paper-collection composite key", async () => {
  const [schema, library, application, collectionMigration, colorMigration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/library/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PaperAssistant.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0003_blushing_preak.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0005_lyrical_victor_mancha.sql", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /primaryKey\(\{ columns: \[table\.paperId, table\.collectionId\] \}\)/);
  assert.match(library, /INSERT OR IGNORE INTO paper_collections \(paper_id, collection_id\)/);
  assert.match(library, /DELETE FROM paper_collections WHERE paper_id = \? AND collection_id = \?/);
  assert.match(library, /createPaper[\s\S]*?if \(Array\.isArray\(data\.collectionNames\)\)[\s\S]*?syncPaperCollectionsByName\(database, id, data\.collectionNames\)/);
  assert.match(application, /Papers in collection/);
  assert.match(application, /All remaining papers/);
  assert.match(application, /aria-label="Remove selected paper from collection"/);
  const collectionSchema = schema.slice(schema.indexOf("export const collections"), schema.indexOf("export const paperCollections"));
  assert.doesNotMatch(collectionSchema, /description: text\("description"\)|color: text\("color"\)/);
  assert.match(collectionMigration, /DROP COLUMN `description`/);
  assert.match(colorMigration, /DROP COLUMN `color`/);
});

test("uses integrated sortable table headers without a detached sort control", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/PaperAssistant.tsx", import.meta.url), "utf8"),
    readApplicationStyles(),
  ]);
  assert.match(component, /SortablePaperHeader/);
  assert.match(component, /aria-sort/);
  assert.doesNotMatch(component, /SORT\s*<\/span>/);
  assert.match(styles, /\.table-sort-button/);
  assert.match(styles, /\.library-toolbar/);
  assert.match(styles, /\.research-grid \.paper-column-check/);
  assert.match(styles, /\.paper-secondary-line/);
  assert.match(component, /function TablePagination/);
  assert.match(component, /ChevronsLeft/);
  assert.match(component, /ChevronsRight/);
  assert.match(component, /pagination-jump/);
  assert.match(styles, /\.table-pagination/);
});

test("combines exact linked-record filters with boolean relationships", async () => {
  const application = await readFile(new URL("../app/components/PaperAssistant.tsx", import.meta.url), "utf8");
  assert.match(application, /interface LibraryFilterClause/);
  assert.match(application, /matchesLibraryFilters/);
  assert.match(application, /collection\.id === clause\.valueId/);
  assert.match(application, /paper\.venueId === clause\.valueId/);
  assert.match(application, /String\(paper\.year \?\? ""\) === clause\.valueId/);
  assert.match(application, /<option value="AND">AND<\/option><option value="OR">OR<\/option>/);
  assert.match(application, />NOT<\/button>/);
  assert.match(application, /Add opening parenthesis/);
  assert.match(application, /createLibraryFilter\("collection", collection\.id/);
  assert.doesNotMatch(application, /onOpen=\{\(collection\) => \{\s*setQuery\(collection\.name\)/);
});

test("tracks long-running work while persisting chat as separate discussions", async () => {
  const [tasks, application, settings, chatWorkspace] = await Promise.all([
    readFile(new URL("../app/components/BackgroundTasks.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PaperAssistant.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SettingsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ChatWorkspace.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(tasks, /runTask/);
  assert.match(tasks, /Activity log/);
  assert.match(tasks, /pa-activity-log-v1/);
  assert.match(application, /Generate summary ·/);
  assert.match(application, /Copy \$\{file\.name\} into PA storage/);
  assert.match(settings, /Sync PA library to OneDrive/);
  assert.match(chatWorkspace, /pa-chat-sessions-v2/);
  assert.match(chatWorkspace, /persistSessions/);
  assert.match(chatWorkspace, /Discussion title/);
  assert.match(chatWorkspace, /session\.titleMode === "auto" \? automaticTitle\(selected\) : session\.title/);
  assert.match(chatWorkspace, /titleMode: titleDraft\.trim\(\) \? "custom" : "auto"/);
  assert.match(chatWorkspace, /className="chat-history-close"[\s\S]*icon=\{<PanelLeftClose \/>\}/);
  assert.match(chatWorkspace, /className="chat-context-close"[\s\S]*icon=\{<PanelRightClose \/>\}/);
  assert.doesNotMatch(chatWorkspace, /runTask/);
});

test("runs the library on a local SQLite file in the self-contained library folder", async () => {
  const [library, bootstrap, dbIndex, adapter, paths, localFiles] = await Promise.all([
    readFile(new URL("../app/api/library/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/sqlite-d1.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/library-paths.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/local-files.ts", import.meta.url), "utf8"),
  ]);
  // The database is a plain SQLite file (better-sqlite3), not Cloudflare D1.
  assert.match(library, /ensureDatabase/);
  assert.match(bootstrap, /SELECT COUNT\(\*\) AS count FROM papers/);
  assert.doesNotMatch(bootstrap, /cloudflare:workers/);
  assert.doesNotMatch(dbIndex, /drizzle-orm\/d1|cloudflare:workers/);
  assert.match(adapter, /import Database from "better-sqlite3"/);
  // Non-WAL journal: the library folder is cloud-synced, where a WAL sidecar
  // could be clobbered mid-write.
  assert.match(adapter, /journal_mode = TRUNCATE/);
  assert.doesNotMatch(adapter, /journal_mode = WAL/);
  // The library folder is the single self-contained location.
  assert.match(paths, /library\.db/);
  assert.match(paths, /settings\.json/);
  assert.match(paths, /export function libraryRoot/);
  // Stored PDFs/HTML are served by a real Node helper with a traversal guard.
  assert.match(localFiles, /application\/pdf/);
  assert.match(localFiles, /basename/);
});

test("backs up the SQLite library snapshot without replacing the live source", async () => {
  const root = await mkdtemp(join(tmpdir(), "pa-sync-test-"));
  const local = join(root, "local");
  const remote = join(root, "remote");
  const databasePath = join(root, "live-d1.sqlite");
  try {
    await mkdir(join(local, "pdfs"), { recursive: true });
    await mkdir(join(local, "html_snapshots"), { recursive: true });
    await writeFile(join(local, "pdfs", "paper.pdf"), "pdf fixture");
    await writeFile(join(local, "html_snapshots", "paper.html"), "<p>fixture</p>");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
    database.exec("INSERT INTO papers VALUES ('paper-1', 'Fixture')");
    database.close();

    const bridgePath = fileURLToPath(new URL("../scripts/pa_sync_bridge.py", import.meta.url));
    const { stdout } = await execFile("python3", [bridgePath, "--local", local, "--database", databasePath, "--remote", remote, "--policy", "local"]);
    const result = JSON.parse(stdout.trim());
    assert.equal(result.ok, true);

    const backup = new DatabaseSync(join(remote, "papers.db"), { readOnly: true });
    assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM papers").get().count, 1);
    backup.close();
    assert.equal(await readFile(join(remote, "pdfs", "paper.pdf"), "utf8"), "pdf fixture");
    assert.equal(await readFile(join(remote, "html_snapshots", "paper.html"), "utf8"), "<p>fixture</p>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
