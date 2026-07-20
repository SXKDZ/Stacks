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
  const [settings, routeSettings, proxy, routeSync, routePicker, bridge, example, ignore] = await Promise.all([
    readFile(new URL("../app/lib/local-settings.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/local-settings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../proxy.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/local-sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/local-directory-picker/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/pa_sync_bridge.py", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);
  // Local settings are served by real Next routes (Node runtime), backed by the
  // self-contained library folder via db/library-paths.
  assert.match(routeSettings, /export const runtime = "nodejs"/);
  // Mutating API requests are CSRF-guarded by the same-origin proxy.
  assert.match(proxy, /sec-fetch-site/);
  assert.match(proxy, /matcher: \["\/api\/:path\*"\]/);
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
  // The backup destination is created if missing and must be outside the live
  // library, but need not pre-exist or be empty.
  assert.match(settings, /mkdirSync\(resolvedRemote/);
  assert.match(settings, /must be outside the live library folder/);
  assert.doesNotMatch(settings, /Choose an existing folder/);
  // App config lives in settings.json now; the env template only seeds secrets
  // and the library-dir bootstrap.
  assert.match(example, /AWS_BEARER_TOKEN_BEDROCK/);
  assert.match(example, /STACKS_LIBRARY_DIR/);
  assert.doesNotMatch(example, /STACKS_MAX_TOKENS|STACKS_TEMPERATURE|STACKS_ONEDRIVE_PATH/);
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
  // Streaming robustness: mid-stream exception frames/events surface as errors
  // (both parsers) and the client abort is forwarded to Bedrock.
  assert.match(bedrock, /messageType === "exception"/);
  assert.match(bedrock, /parsed\.type === "error" \|\| parsed\.error/);
  assert.match(bedrock, /signal: options\.signal/);
  // AI routes pin the Node runtime.
  const chatRoute = await readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
  assert.match(chatRoute, /export const runtime = "nodejs"/);
  assert.match(chatRoute, /signal: request\.signal/);
  // Grounding is fetched concurrently, not in a sequential await loop.
  assert.match(chatRoute, /Promise\.all\(\s*papers\.map/);
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
  // Preferences persist to the app_settings table through the Drizzle ORM.
  assert.match(settingsStore, /appSettings/);
  assert.match(doctor, /PRAGMA quick_check/);
  assert.match(doctor, /PRAGMA foreign_key_check/);
  assert.match(doctor, /orphanedAssociations/);
  // Doctor also reports and cleans entities (authors/venues/collections) left with no papers.
  assert.match(doctor, /orphanedEntities/);
  assert.match(doctor, /DELETE FROM authors WHERE id NOT IN/);
  assert.match(doctor, /DELETE FROM venues WHERE id NOT IN/);
  assert.match(doctor, /DELETE FROM collections WHERE id NOT IN/);
  // Moving the library is implemented (consistent backup + repoint), not stubbed.
  assert.match(doctor, /async function moveLibrary/);
  assert.match(doctor, /setLibraryRoot\(target\)/);
  assert.match(doctor, /folderMove: true/);
  assert.doesNotMatch(doctor, /Move the library folder from the filesystem/);
  assert.match(chat, /STACKS_PDF_PAGES/);
  assert.match(chat, /pdfStartPage/);
  assert.match(grounding, /getDocumentProxy/);
  // SSRF guards live in the shared url-safety module and are used on every
  // server-side fetch of a user-supplied URL (grounding + source acquisition).
  const [urlSafety, localFiles] = await Promise.all([
    readFile(new URL("../app/lib/url-safety.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/local-files.ts", import.meta.url), "utf8"),
  ]);
  assert.match(urlSafety, /redirect: "manual"/);
  assert.match(urlSafety, /publicHttpsUrl/);
  assert.match(grounding, /from "@\/app\/lib\/url-safety"/);
  assert.match(localFiles, /safeFetch/);
  assert.doesNotMatch(localFiles, /redirect: "follow"/);
  assert.match(settingsView, /PDF grounding pages/);
  assert.match(settingsView, /About & updates/);
  assert.match(version, /releases\/latest/);
});

test("captures webpage snapshots with WebKit and rejects challenge pages instead of Jina", async () => {
  const [snapshot, localFiles, importRoute, summarize, envExample] = await Promise.all([
    readFile(new URL("../app/lib/webpage-snapshot.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/local-files.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/summarize/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  // Snapshots render locally in headless WebKit (Playwright), no external reader.
  assert.match(snapshot, /from "playwright"/);
  assert.match(snapshot, /webkit\.launch/);
  assert.match(snapshot, /looksBlocked/);
  assert.match(snapshot, /verifying your browser/i);
  // Acquisition and the URL-import/summarize paths use the snapshot, not Jina.
  assert.match(localFiles, /captureWebpageSnapshot/);
  assert.match(importRoute, /captureWebpageSnapshot/);
  assert.match(summarize, /captureWebpageSnapshot/);
  // Jina is fully removed from the codebase and env template.
  assert.doesNotMatch(localFiles, /jina/i);
  assert.doesNotMatch(importRoute, /jina/i);
  assert.doesNotMatch(summarize, /jina/i);
  assert.doesNotMatch(envExample, /JINA_API_KEY/);
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
  // Membership is reconciled through Drizzle: idempotent inserts + composite-key deletes.
  assert.match(library, /\.insert\(paperCollections\)[\s\S]*?\.onConflictDoNothing\(\)/);
  assert.match(library, /\.delete\(paperCollections\)[\s\S]*?eq\(paperCollections\.paperId[\s\S]*?eq\(paperCollections\.collectionId/);
  assert.match(library, /resolveCollectionIdsByName\(tx, data\.collectionNames\)/);
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
  assert.match(settings, /Back up Stacks library to OneDrive/);
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
  const [library, bootstrap, dbIndex, client, paths, localFiles] = await Promise.all([
    readFile(new URL("../app/api/library/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/client.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/library-paths.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/local-files.ts", import.meta.url), "utf8"),
  ]);
  // The database is a plain SQLite file (better-sqlite3) queried through the
  // Drizzle ORM — there is no Cloudflare D1 or D1-compatible adapter left.
  assert.match(library, /ensureDatabase/);
  assert.match(library, /from "drizzle-orm"/);
  assert.match(library, /from "@\/db\/schema"/);
  // Imported/edited metadata is normalized (title case, author ordering, pages).
  assert.match(library, /from "@\/app\/lib\/metadata-normalize"/);
  assert.match(library, /normalizeTitle\(/);
  // Deleting a paper removes its managed files from disk.
  assert.match(library, /removeStoredFile\("pdf"/);
  assert.match(localFiles, /export function removeStoredFile/);
  assert.match(bootstrap, /SELECT COUNT\(\*\) AS count FROM papers/);
  assert.doesNotMatch(bootstrap, /cloudflare:workers/);
  assert.doesNotMatch(dbIndex, /drizzle-orm\/d1|cloudflare:workers/);
  assert.match(client, /import Database from "better-sqlite3"/);
  assert.match(client, /drizzle-orm\/better-sqlite3/);
  // Reopen when the resolved library path changes (folder move at runtime).
  assert.match(client, /connection\.file !== file/);
  // Non-WAL journal: the library folder is cloud-synced, where a WAL sidecar
  // could be clobbered mid-write.
  assert.match(client, /journal_mode = TRUNCATE/);
  assert.doesNotMatch(client, /journal_mode = WAL/);
  // The library folder is the single self-contained location.
  assert.match(paths, /library\.db/);
  assert.match(paths, /settings\.json/);
  assert.match(paths, /export function libraryRoot/);
  // The live library defaults to a local path; OneDrive is only a backup target.
  // The live library defaults to a local path under ~/.stacks; OneDrive is only a backup target.
  assert.match(paths, /"\.stacks"/);
  assert.match(paths, /defaultLibraryRoot = join\(configDir, "library"\)/);
  // Stored PDFs/HTML are served by a real Node helper with a traversal guard.
  assert.match(localFiles, /application\/pdf/);
  assert.match(localFiles, /basename/);
});

test("backs up the local library one-way to OneDrive without replacing the live source", async () => {
  const root = await mkdtemp(join(tmpdir(), "pa-backup-test-"));
  const local = join(root, "local");
  const remote = join(root, "remote");
  const databasePath = join(local, "library.db");
  try {
    await mkdir(join(local, "pdfs"), { recursive: true });
    await mkdir(join(local, "html_snapshots"), { recursive: true });
    await writeFile(join(local, "pdfs", "paper.pdf"), "pdf fixture");
    await writeFile(join(local, "html_snapshots", "paper.html"), "<p>fixture</p>");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
    database.exec("INSERT INTO papers VALUES ('paper-1', 'Fixture')");
    database.close();

    // The backup folder does not exist yet: the bridge must create it rather
    // than fail, and pre-existing contents (once present) must never be deleted.
    await mkdir(remote, { recursive: true });
    await writeFile(join(remote, "unrelated-user-file.txt"), "keep me");

    const bridgePath = fileURLToPath(new URL("../scripts/pa_sync_bridge.py", import.meta.url));
    const { stdout } = await execFile("python3", [bridgePath, "--local", local, "--database", databasePath, "--remote", remote]);
    const result = JSON.parse(stdout.trim());
    assert.equal(result.ok, true);
    // One-way and additive: an unrelated file in a non-empty destination survives.
    assert.equal(await readFile(join(remote, "unrelated-user-file.txt"), "utf8"), "keep me");

    // The backup copy mirrors the live database name (library.db), consistently.
    const backup = new DatabaseSync(join(remote, "library.db"), { readOnly: true });
    assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM papers").get().count, 1);
    backup.close();
    assert.equal(await readFile(join(remote, "pdfs", "paper.pdf"), "utf8"), "pdf fixture");
    assert.equal(await readFile(join(remote, "html_snapshots", "paper.html"), "utf8"), "<p>fixture</p>");

    // A second run is idempotent: nothing changes when the backup is current.
    const { stdout: second } = await execFile("python3", [bridgePath, "--local", local, "--database", databasePath, "--remote", remote]);
    const secondResult = JSON.parse(second.trim());
    assert.equal(Object.values(secondResult.changes).reduce((a, b) => a + b, 0), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
