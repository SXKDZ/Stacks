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
  // db/schema.ts drives the typed queries and db/bootstrap.ts creates the tables;
  // together they are the single source of truth for the schema (no migration
  // files). Legacy author columns must be absent from both.
  const [schema, bootstrap] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /export const authors = sqliteTable/);
  assert.match(schema, /export const venues = sqliteTable/);
  assert.match(schema, /export const paperAuthors = sqliteTable/);
  assert.match(schema, /authorOrder/);
  assert.match(schema, /onDelete: "set null"/);
  assert.match(schema, /onUpdate: "cascade"/);
  assert.doesNotMatch(schema, /email:/);
  assert.doesNotMatch(schema, /affiliation:|hIndex:|citationCount:/);
  const authorsTable = bootstrap.slice(bootstrap.indexOf("CREATE TABLE IF NOT EXISTS authors"));
  const authorsCreate = authorsTable.slice(0, authorsTable.indexOf(")`"));
  assert.doesNotMatch(authorsCreate, /email|affiliation|h_index|citation_count/);
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
  // The summary prompt separates paper text ({{paper}}) from record fields
  // ({{metadata}}); extraction's source_text still carries a page-range slice.
  assert.match(prompts, /\{\{metadata\}\}/);
  assert.match(prompts, /\{\{source_text\[1:2\]\}\}/);
  assert.match(prompts, /export function pageSliceFor/);
  assert.doesNotMatch(prompts, /\{\{papers\}\}|DEFAULT_CHAT_SYSTEM_PROMPT/);
  // The client forwards the caller's abort signal to Bedrock so a cancelled
  // request stops upstream too.
  assert.match(bedrock, /signal: options\.signal/);
  // The summarize route pins the Node runtime and grounds {{paper}} in the
  // stored PDF, page-sliced the same way extraction is (shared readPdfPages).
  const [summarizeRoute, pdfText] = await Promise.all([
    readFile(new URL("../app/api/summarize/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/pdf-text.ts", import.meta.url), "utf8"),
  ]);
  assert.match(summarizeRoute, /export const runtime = "nodejs"/);
  assert.match(summarizeRoute, /pageSliceFor\(configuredPrompt, "paper"\)/);
  assert.match(summarizeRoute, /readPdfPages|readPaperText/);
  assert.match(pdfText, /export async function readPdfPages/);
});

test("ships deployed settings, database Doctor, PDF grounding, and update checks", async () => {
  const [bootstrap, localSettings, runtimeConfig, doctor, settingsView, version] = await Promise.all([
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/local-settings.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/runtime-config.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/storage-management/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SettingsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/version/route.ts", import.meta.url), "utf8"),
  ]);
  // Settings have one source of truth: settings.json (local-settings). The
  // parallel app_settings DB table and settings-store are retired — the schema
  // never creates app_settings or the scaffolded tag tables.
  assert.doesNotMatch(bootstrap, /app_settings/);
  assert.doesNotMatch(bootstrap, /CREATE TABLE IF NOT EXISTS (tags|paper_tags)/);
  assert.match(localSettings, /export function runtimeValues/);
  assert.match(runtimeConfig, /runtimeValues/);
  assert.doesNotMatch(runtimeConfig, /settings-store/);
  assert.match(settingsView, /"\/api\/local-settings"/);
  assert.doesNotMatch(settingsView, /"\/api\/settings"/);
  // A partial save must NOT reset untouched numeric/boolean fields to their
  // hardcoded defaults: each falls back to the saved value (via envValue) when
  // the payload omits it. Regression guard for the "maxTokens reverts to default"
  // bug — the old `Number(data.maxTokens) || 1200` clobbered on any partial POST.
  assert.doesNotMatch(localSettings, /Number\(data\.maxTokens\) \|\| \d/);
  assert.doesNotMatch(localSettings, /Number\(data\.autoSyncInterval\) \|\| \d/);
  assert.match(localSettings, /clampInt\(data\.maxTokens, envValue\("STACKS_MAX_TOKENS"/);
  assert.match(localSettings, /data\.autoSync === undefined \? envValue\("STACKS_AUTO_SYNC"/);
  // The default output-token ceiling is generous (>= 10000) so summaries aren't
  // truncated out of the box.
  assert.match(localSettings, /STACKS_MAX_TOKENS", "10000"/);
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
  // SSRF guards live in the shared url-safety module and are used on every
  // server-side fetch of a user-supplied URL (source acquisition + snapshots).
  const [urlSafety, localFiles] = await Promise.all([
    readFile(new URL("../app/lib/url-safety.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/local-files.ts", import.meta.url), "utf8"),
  ]);
  assert.match(urlSafety, /redirect: "manual"/);
  assert.match(urlSafety, /publicHttpsUrl/);
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
  const [schema, library, application, controls, bootstrap, types] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/library/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ui/controls.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/types.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /primaryKey\(\{ columns: \[table\.paperId, table\.collectionId\] \}\)/);
  // Membership is reconciled through Drizzle: idempotent inserts + composite-key deletes.
  assert.match(library, /\.insert\(paperCollections\)[\s\S]*?\.onConflictDoNothing\(\)/);
  assert.match(library, /\.delete\(paperCollections\)[\s\S]*?eq\(paperCollections\.paperId[\s\S]*?eq\(paperCollections\.collectionId/);
  assert.match(library, /resolveCollectionIdsByName\(tx, data\.collectionNames\)/);
  assert.match(application, /Papers in collection/);
  assert.match(application, /All remaining papers/);
  assert.match(application, /aria-label="Remove selected paper from collection"/);
  // The unused legacy description column is gone; color is a real feature. The
  // authoritative CREATE TABLE in bootstrap.ts must not carry description.
  const collectionsTable = bootstrap.slice(bootstrap.indexOf("CREATE TABLE IF NOT EXISTS collections"));
  assert.doesNotMatch(collectionsTable.slice(0, collectionsTable.indexOf(")`")), /description/);
  const collectionSchema = schema.slice(schema.indexOf("export const collections"), schema.indexOf("export const paperCollections"));
  assert.doesNotMatch(collectionSchema, /description: text\("description"\)/);
  assert.match(collectionSchema, /color: text\("color"\)/);
  // The collections table declares color in its CREATE statement; bootstrap
  // backfills a spread of colors onto any pre-existing uncolored rows.
  assert.match(bootstrap, /CREATE TABLE IF NOT EXISTS collections[\s\S]*?color TEXT/);
  assert.match(bootstrap, /UPDATE collections SET color = \? WHERE id = \?/);
  // Colors are a fixed 12-hue palette (blue default), validated on read + write.
  assert.match(types, /"blue", "indigo", "violet", "pink", "rose", "orange"/);
  assert.match(types, /DEFAULT_COLLECTION_COLOR: CollectionColor = "blue"/);
  assert.match(types, /export function normalizeCollectionColor/);
  assert.match(library, /normalizeCollectionColor\(data\.color\)/);
  // The picker lives in Stacks; the paper-list color dot moved into the shared
  // CollectionChip control, which Stacks renders for every collection tag.
  assert.match(application, /collection-color-swatch/);
  assert.match(application, /CollectionChip/);
  assert.match(controls, /collection-chip-dot/);
});

test("enforces paper identifier uniqueness and atomic proposal/seed handling", async () => {
  const [schema, bootstrap, library, proposal] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/library/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/proposals/[id]/route.ts", import.meta.url), "utf8"),
  ]);
  // arXiv / Semantic Scholar ids are unique (import dedup relies on it), and the
  // bootstrap creates the indexes after unlinking any pre-existing duplicates.
  assert.match(schema, /uniqueIndex\("papers_arxiv_id_unique"\)/);
  assert.match(schema, /uniqueIndex\("papers_semantic_scholar_id_unique"\)/);
  assert.match(bootstrap, /CREATE UNIQUE INDEX IF NOT EXISTS papers_arxiv_id_unique/);
  assert.match(bootstrap, /CREATE UNIQUE INDEX IF NOT EXISTS papers_semantic_scholar_id_unique/);
  assert.match(bootstrap, /ROW_NUMBER\(\) OVER \(PARTITION BY \$\{column\}/);
  // The duplicate check runs inside the insert transaction (not check-then-insert
  // before it), so a concurrent create can't slip a duplicate past it.
  assert.match(library, /if \(findDuplicatePaper\(tx, data\)\) \{\s*throw new DuplicatePaperError/);
  // Feeds are one-per-issue and GitHub sync is serialized by a run mutex.
  assert.match(schema, /uniqueIndex\("feed_snippets_issue_number_unique"\)/);
  // Proposal approval atomically claims the row out of pending before applying,
  // so two concurrent resolves can't both apply the mutation.
  assert.match(proposal, /and\(eq\(feedProposals\.id, id\), eq\(feedProposals\.status, "pending"\)\)/);
  assert.match(proposal, /claimed\.changes === 0/);
  // The demo seed is gated on a persistent marker, not an empty papers table, so
  // deleting every paper never resurrects the demo content.
  assert.match(bootstrap, /user_version/);
  assert.match(bootstrap, /pragma\("user_version = 1"\)/);
});

test("surfaces failed agent launches and keeps filters/selection consistent", async () => {
  const [agent, application] = await Promise.all([
    readFile(new URL("../app/lib/feed-agent.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
  ]);
  // A pre-spawn failure (disk full, DB locked, bad env) is turned into a visible
  // "error" status instead of a rejected promise the caller swallows.
  assert.match(agent, /} catch \(error\) \{[\s\S]*?setStatus\(snippetId, "error"/);
  // Process listeners attach synchronously after spawn (no await between), and
  // cleanup only fires for the handle that still owns the run slot.
  assert.match(agent, /const releaseRun = \(\) => \{[\s\S]*?runs\.get\(snippetId\) === handle/);
  // stopFeedAndWait escalates to SIGKILL rather than returning with a live
  // process a second --resume could then race on the same transcript.
  assert.match(agent, /signalRun\(snippetId, "SIGKILL"\)/);
  // An unset filter clause is a no-op, not an always-false that hides everything.
  assert.match(application, /An unset clause[\s\S]*?if \(!clause\.valueId\) \{\s*return true;/);
  // Selection is pruned to the visible/filtered set so bulk actions never touch
  // hidden rows.
  assert.match(application, /Keep the selection confined to currently-visible papers/);
  assert.match(application, /const visible = new Set\(filtered\.map/);
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
  // The join picker is the shared Select control (no native <select>/<option>).
  assert.match(application, /options=\{\[\{ value: "AND", label: "AND" \}, \{ value: "OR", label: "OR" \}\]\}/);
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
  // Attached library papers are referenced by id, NOT copied into the feed dir
  // (that duplicated large PDFs per turn); the agent reads the original via the
  // token-gated file API. Only uploads are staged, so no copyFileSync remains.
  assert.match(attachments, /kind: "paper", paperId/);
  assert.doesNotMatch(attachments, /copyFileSync/);
  // The feed is always on: no enable gate remains.
  assert.doesNotMatch(feed, /feedEnabled/);
  assert.doesNotMatch(settings, /feedEnabled/);
  // The abandoned editable-note and PROMPT-CHAIN workflow experiments are fully
  // removed: no schema columns, no note UI, no scheduler, no queued-step model.
  // (This is distinct from the Claude Code workflow runtime added later, which
  // runs whole .js scripts — see the workflow-runtime test below.)
  const [schema, bootstrap] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(schema, /note: text\("note"\)/);
  assert.doesNotMatch(schema, /workflowSteps/);
  // Bootstrap drops the two retired columns from any pre-existing library.
  assert.match(bootstrap, /DROP COLUMN note/);
  assert.match(bootstrap, /DROP COLUMN workflow_steps/);
  assert.doesNotMatch(feed, /feed-note-editor/);
  assert.doesNotMatch(feed, /pendingWorkflowSteps|runNextWorkflowStep/);
  // The prompt-chain scheduler UI is gone (the current Workflows editor is a
  // different feature — running whole .js scripts, covered by its own test).
  assert.doesNotMatch(settings, /feed-workflow-schedule|workflow-step-index/);
  for (const gone of [
    "../app/lib/feed-workflows.ts",
    "../app/lib/feed-scheduler.ts",
    "../instrumentation.ts",
  ]) {
    await assert.rejects(readFile(new URL(gone, import.meta.url), "utf8"));
  }
});

test("agent reads attached library papers via token-gated API, not eager copies", async () => {
  const [attachments, metaRoute, fileRoute, prompt, agent, stacks] = await Promise.all([
    readFile(new URL("../app/lib/feed-attachments.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/library/papers/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/library/papers/[id]/file/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/feed-prompt.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/feed-agent.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
  ]);
  // Papers are referenced by id (no file copy); only uploads are staged.
  assert.match(attachments, /kind: "paper", paperId/);
  assert.doesNotMatch(attachments, /copyFileSync/);
  // Both agent endpoints are token-gated (same bearer token as /api/feed/library).
  assert.match(metaRoute, /snippetForToken/);
  assert.match(fileRoute, /snippetForToken/);
  // Metadata is flat (hasFile/fileUrl merged onto the paper), so the agent reads
  // paper.hasFile directly rather than digging for a sibling object.
  assert.match(metaRoute, /\.\.\.paper,\s*\n\s*hasFile/);
  // The file endpoint streams the original stored PDF/HTML, confined by resolveStoredFile.
  assert.match(fileRoute, /servePdfFile|serveHtmlSnapshot/);
  assert.match(fileRoute, /resolveStoredFile/);
  // The agent gets /tmp as scratch space to download attached papers into.
  assert.match(agent, /"--add-dir",\s*\n\s*"\/tmp"/);
  // The prompt tells the agent to fetch the paper file into /tmp and read it.
  assert.match(prompt, /api\/feed\/library\/papers\/<id>\/file/);
  // Clicking a paper attachment deep-links to the library, consumed on load.
  assert.match(stacks, /searchParams.*\.get\("paper"\)|URLSearchParams\(window\.location\.search\)\.get\("paper"\)/);
});

test("runs Claude Code workflow scripts through the approval-gated feed", async () => {
  const [runtime, route, agent] = await Promise.all([
    readFile(new URL("../app/lib/workflow-runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/workflows/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/feed-agent.ts", import.meta.url), "utf8"),
  ]);
  // The runtime injects the CC workflow primitives and runs the script in a vm.
  assert.match(runtime, /export async function runWorkflow/);
  assert.match(runtime, /export function readWorkflowMeta/);
  assert.match(runtime, /base\.agent =|const agent =/);
  assert.match(runtime, /base\.parallel =/);
  assert.match(runtime, /base\.pipeline =/);
  assert.match(runtime, /vm\.runInContext/);
  // node:vm is not a sandbox: the runtime must NOT inject host-realm intrinsics
  // (Object/Array/Promise/...) into the context — that is what makes
  // `Object.constructor('return process')()` reach the host. The context's own
  // realm supplies working built-ins; primitive results are re-homed to it.
  assert.doesNotMatch(runtime, /JSON,\s*Math,\s*Array,\s*Object/);
  assert.match(runtime, /realmResult/);
  // Each agent() turn goes through the feed runner, so writes stay approval-gated.
  assert.match(runtime, /runFeedAgent/);
  // runFeedAgent now resolves with the turn result so a workflow can await it.
  assert.match(agent, /Promise<AgentTurnResult>/);
  // The workflows are saved (CRUD) and validated via the script's meta.
  assert.match(route, /readFeedWorkflows|writeFeedWorkflows/);
  assert.match(route, /readWorkflowMeta/);
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
  // Only one sync runs at a time; overlapping runs would duplicate issues/feeds.
  assert.match(sync, /syncInProgress/);
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
  // Collapsing a feed closes its issue on sync (reopened when expanded), tracked
  // by a 3-way base so the API is only called on a real state change.
  assert.match(client, /patchIssueState/);
  assert.match(sync, /issueStateSynced/);
  assert.match(sync, /issuesClosed/);
});

test("deleting a mirrored feed closes its issue via a durable, repo-scoped outbox", async () => {
  const [schema, bootstrap, outbox, deleteRoute, sync, boot] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/feed-github-outbox.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/snippets/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/github/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
  ]);
  // A standalone outbox table (not tied to feed_snippets: the feed is gone) with
  // the repo the op targets, so switching repos never fires a stale close.
  assert.match(schema, /export const feedGithubOutbox = sqliteTable/);
  assert.match(bootstrap, /CREATE TABLE IF NOT EXISTS feed_github_outbox/);
  assert.match(bootstrap, /repo TEXT NOT NULL/);
  // The op is scoped + deduped by (repo, issue) and retried until GitHub confirms.
  assert.match(outbox, /eq\(feedGithubOutbox\.repo, repo\)/);
  assert.match(outbox, /patchIssueState\(config, item\.issueNumber, "closed"\)/);
  // A 404/410 (already gone) is treated as done, not retried forever.
  assert.match(outbox, /status === 404 \|\| status === 410/);
  // Delete enqueues the close and flushes immediately (fire-and-forget).
  assert.match(deleteRoute, /enqueueCloseIssue\(snippet\.issueNumber\)/);
  assert.match(deleteRoute, /void flushGithubOutbox\(\)/);
  // Sync drains the outbox BEFORE the inbound pass, so a deleted feed's issue is
  // already closed and won't be recreated from an open issue.
  assert.match(sync, /await flushGithubOutbox\(\)/);
  // Startup also flushes, so a delete made offline still reaches GitHub.
  assert.match(boot, /flushGithubOutbox/);
});

test("feeds can be collapsed without reordering the list", async () => {
  const [schema, bootstrap, patchRoute, feed] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/snippets/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
  ]);
  // The collapsed flag is a real column, present in CREATE TABLE and back-filled.
  assert.match(schema, /collapsed: integer\("collapsed"/);
  assert.match(bootstrap, /CREATE TABLE IF NOT EXISTS feed_snippets[\s\S]*?collapsed INTEGER NOT NULL DEFAULT 0/);
  assert.match(bootstrap, /ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0/);
  // Collapsing must NOT bump updatedAt (only a rename does), so the feed keeps
  // its list position when expanded again.
  assert.match(patchRoute, /Collapsing\/expanding is a shelving action/);
  assert.match(patchRoute, /changes\.updatedAt = new Date/);
  // The sidebar renders a dedicated collapsed section.
  assert.match(feed, /feed-collapsed-group/);
  assert.match(feed, /Collapsed feeds/);
});

test("runs the library on a local SQLite file in the self-contained library folder", async () => {
  const [library, bootstrap, client, paths, localFiles] = await Promise.all([
    readFile(new URL("../app/api/library/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
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
  assert.doesNotMatch(bootstrap, /cloudflare:workers|drizzle-orm\/d1/);
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
    await mkdir(join(local, "feed", ".claude", "projects", "p1"), { recursive: true });
    await writeFile(join(local, "pdfs", "paper.pdf"), "pdf fixture");
    await writeFile(join(local, "html_snapshots", "paper.html"), "<p>fixture</p>");
    await writeFile(join(local, "feed", "feed-1", "attachments", "notes.txt"), "attachment fixture");
    // A session transcript (backed up) and machine-specific state (excluded).
    await writeFile(join(local, "feed", ".claude", "projects", "p1", "session.jsonl"), "{\"t\":\"turn\"}\n");
    await writeFile(join(local, "feed", ".claude", ".claude.json"), "{\"machineID\":\"local-only\"}");
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
    // Agent transcripts are backed up so restored feeds can resume; machine-
    // specific .claude.json stays local.
    assert.equal(await readFile(join(remote, "feed", ".claude", "projects", "p1", "session.jsonl"), "utf8"), "{\"t\":\"turn\"}\n");
    await assert.rejects(readFile(join(remote, "feed", ".claude", ".claude.json"), "utf8"));
    // The whole-file database copy counts as ONE change, not one-per-paper.
    assert.equal(result.changes.database, 1);

    // A second run is idempotent: nothing changes when the backup is current.
    const { stdout: second } = await execFile("python3", [bridgePath, "--local", local, "--database", databasePath, "--remote", remote]);
    const secondResult = JSON.parse(second.trim());
    assert.equal(Object.values(secondResult.changes).reduce((a, b) => a + b, 0), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto-back up runs a debounced backup after live library changes", async () => {
  const [settings, library] = await Promise.all([
    readFile(new URL("../app/lib/local-settings.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/library/route.ts", import.meta.url), "utf8"),
  ]);
  // A debounced scheduler exists, gated on the autoSync toggle + a real target.
  assert.match(settings, /export function scheduleAutoSync/);
  assert.match(settings, /if \(!sync\.autoSync \|\| !sync\.sourceExists \|\| !sync\.remotePath\.trim\(\)\)/);
  // It coalesces via a single timer and clamps the delay to the 5–3600s bounds.
  assert.match(settings, /clearTimeout\(autoSyncTimer\)/);
  assert.match(settings, /Math\.min\(3600, Math\.max\(5, Number\(sync\.autoSyncInterval\)/);
  // A backup already in flight defers a re-run rather than overlapping.
  assert.match(settings, /if \(syncRunning\) \{\s*autoSyncPending = true/);
  // The library mutation route triggers it after a successful change.
  assert.match(library, /import \{ scheduleAutoSync \} from "@\/app\/lib\/local-settings"/);
  assert.match(library, /scheduleAutoSync\(\);\s*\n\s*return Response\.json\(await readSnapshot\(\)\)/);
});
