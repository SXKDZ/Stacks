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
    readFile(new URL("../scripts/stacks_sync_bridge.py", import.meta.url), "utf8"),
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
  assert.match(bridge, /stacks_sync\.lock/);
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
  // The summary and extraction prompts survive chat removal; the discussion
  // prompt and its {{papers}}/{{paper1}} placeholders are gone.
  assert.match(prompts, /\{\{paper\}\}/);
  // source_text now carries a page-range slice, e.g. {{source_text[1:2]}}.
  assert.match(prompts, /\{\{source_text\[1:2\]\}\}/);
  assert.match(prompts, /export function pageSliceFor/);
  assert.doesNotMatch(prompts, /\{\{papers\}\}|DEFAULT_CHAT_SYSTEM_PROMPT/);
  // Streaming robustness: mid-stream exception frames/events surface as errors
  // (both parsers) and the client abort is forwarded to Bedrock.
  assert.match(bedrock, /messageType === "exception"/);
  assert.match(bedrock, /parsed\.type === "error" \|\| parsed\.error/);
  assert.match(bedrock, /signal: options\.signal/);
  // The summarize route pins the Node runtime and streams from Bedrock.
  const summarizeRoute = await readFile(new URL("../app/api/summarize/route.ts", import.meta.url), "utf8");
  assert.match(summarizeRoute, /export const runtime = "nodejs"/);
});

test("ships deployed settings, database Doctor, PDF grounding, and update checks", async () => {
  const [bootstrap, localSettings, runtimeConfig, doctor, grounding, settingsView, version] = await Promise.all([
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/local-settings.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/runtime-config.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/storage-management/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/document-grounding.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SettingsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/version/route.ts", import.meta.url), "utf8"),
  ]);
  // Settings have one source of truth: settings.json (local-settings). The
  // parallel app_settings DB table and settings-store are retired.
  assert.doesNotMatch(bootstrap, /CREATE TABLE IF NOT EXISTS app_settings/);
  assert.match(bootstrap, /DROP TABLE IF EXISTS app_settings/);
  assert.match(localSettings, /export function runtimeValues/);
  assert.match(runtimeConfig, /runtimeValues/);
  assert.doesNotMatch(runtimeConfig, /settings-store/);
  assert.match(settingsView, /"\/api\/local-settings"/);
  assert.doesNotMatch(settingsView, /"\/api\/settings"/);
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
  // The dead PDF-grounding-pages control and Discussion prompt are gone.
  assert.doesNotMatch(settingsView, /PDF grounding pages|Discussion system prompt|chatSystem/);
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
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
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
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
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
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
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
  const application = await readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8");
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

test("tracks long-running work and drives the AI feed instead of a chat workspace", async () => {
  const [tasks, application, settings, feed, attachBox, snippetsRoute, attachments] = await Promise.all([
    readFile(new URL("../app/components/BackgroundTasks.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SettingsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/feed/AttachBox.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/snippets/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/feed-attachments.ts", import.meta.url), "utf8"),
  ]);
  assert.match(tasks, /runTask/);
  assert.match(tasks, /Activity log/);
  assert.match(tasks, /stacks-activity-log-v1/);
  assert.match(application, /Generate summary ·/);
  assert.match(application, /Copy \$\{file\.name\} into Stacks storage/);
  assert.match(settings, /Back up Stacks library to OneDrive/);
  // Chat is fully removed: no chat route, api, component, or entry points remain.
  assert.doesNotMatch(application, /openChatWorkspace|\/chat/);
  assert.match(application, /openFeedWorkspace/);
  // The feed is the AI surface: it opens with a paper attached, and both the
  // composer and reply share one AttachBox supporting files + library papers,
  // clipboard paste, and drag-drop.
  assert.match(feed, /\/feed\?paper=|params\.get\("paper"\)/);
  assert.match(feed, /<AttachBox/);
  assert.match(feed, /new FormData\(\)/);
  assert.match(attachBox, /feed-attach-tray/);
  assert.match(attachBox, /onPaste=/);
  assert.match(attachBox, /onDrop=/);
  assert.match(attachBox, /feed-picker/);
  assert.match(snippetsRoute, /multipart\/form-data/);
  assert.match(snippetsRoute, /collectSnippetAttachments/);
  assert.match(attachments, /storedDirectory/);
  // The feed is always on: no enable gate remains.
  assert.doesNotMatch(feed, /feedEnabled/);
  assert.doesNotMatch(settings, /feedEnabled/);
});

test("mirrors feeds to a private GitHub repo as a remote inbox, loop-safely", async () => {
  const [client, sync, feed, settingsLib] = await Promise.all([
    readFile(new URL("../app/lib/github-sync.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/github/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/local-settings.ts", import.meta.url), "utf8"),
  ]);
  // The client only ever talks to api.github.com and refuses redirects, so a
  // malformed repo setting can't redirect requests elsewhere (SSRF guard).
  assert.match(client, /https:\/\/api\.github\.com/);
  assert.match(client, /redirect:\s*"error"/);
  // Stacks-authored comments carry a marker so sync never re-ingests its own
  // output as a new human instruction.
  assert.match(client, /stacks:agent/);
  assert.match(sync, /fromStacks/);
  // Dedup is by stored comment id, and a busy feed defers its comments to the
  // next pass rather than dropping them.
  assert.match(sync, /githubCommentId/);
  assert.match(sync, /isFeedRunning/);
  // Full pagination (follow Link rel=next) and incremental pulls (since=).
  assert.match(client, /rel="next"/);
  assert.match(client, /since=/);
  assert.match(sync, /readGithubLastSyncedAt/);
  assert.match(sync, /writeGithubLastSyncedAt/);
  // Bidirectional title rename (3-way base) and comment-edit adoption.
  assert.match(client, /patchIssueTitle/);
  assert.match(sync, /issueTitleSynced/);
  assert.match(sync, /commentsUpdated/);
  // Attachments are uploaded to the repo (Contents API) and linked in comments.
  assert.match(client, /uploadAttachment/);
  assert.match(client, /\/contents\//);
  assert.match(sync, /mirrorAttachments/);
  // Proposed library changes + their status are mirrored to the issue.
  assert.match(sync, /proposalCommentBody/);
  assert.match(sync, /githubStatusSynced/);
  assert.match(client, /editComment/);
  // Settings persist a repo (non-secret) and token (secret) in settings.json.
  assert.match(settingsLib, /STACKS_GITHUB_REPO/);
  assert.match(settingsLib, /GITHUB_TOKEN/);
  // A manual "Sync now" affordance exists, gated on being configured.
  assert.match(feed, /githubReady/);
  assert.match(feed, /\/api\/feed\/github\/sync/);
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
    await mkdir(join(local, "feed", "feed-1", "attachments"), { recursive: true });
    await writeFile(join(local, "pdfs", "paper.pdf"), "pdf fixture");
    await writeFile(join(local, "html_snapshots", "paper.html"), "<p>fixture</p>");
    await writeFile(join(local, "feed", "feed-1", "attachments", "notes.txt"), "attachment fixture");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
    database.exec("INSERT INTO papers VALUES ('paper-1', 'Fixture')");
    database.close();

    // The backup folder does not exist yet: the bridge must create it rather
    // than fail, and pre-existing contents (once present) must never be deleted.
    await mkdir(remote, { recursive: true });
    await writeFile(join(remote, "unrelated-user-file.txt"), "keep me");

    const bridgePath = fileURLToPath(new URL("../scripts/stacks_sync_bridge.py", import.meta.url));
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
    // Feed attachments are backed up too, preserving their nested path.
    assert.equal(await readFile(join(remote, "feed", "feed-1", "attachments", "notes.txt"), "utf8"), "attachment fixture");

    // A second run is idempotent: nothing changes when the backup is current.
    const { stdout: second } = await execFile("python3", [bridgePath, "--local", local, "--database", databasePath, "--remote", remote]);
    const secondResult = JSON.parse(second.trim());
    assert.equal(Object.values(secondResult.changes).reduce((a, b) => a + b, 0), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
