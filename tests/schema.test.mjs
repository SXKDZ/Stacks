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
  assert.match(settings, /"remote" \| "storage"/);
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
  const [models, bedrock, prompts, settings, designSystem, settingsStyles] = await Promise.all([
    readFile(new URL("../app/api/models/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/bedrock.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/ai-prompts.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SettingsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/styles/design-system.css", import.meta.url), "utf8"),
    readFile(new URL("../app/styles/settings.css", import.meta.url), "utf8"),
  ]);
  assert.match(models, /bedrock-mantle/);
  assert.match(models, /inference-profiles/);
  assert.match(models, /openai\/v1\/models/);
  for (const model of ["openai.gpt-5.6-sol", "openai.gpt-5.6-terra", "openai.gpt-5.6-luna"]) {
    assert.match(models, new RegExp(model.replaceAll(".", "\\.")));
    assert.match(settings, new RegExp(model.replaceAll(".", "\\.")));
  }
  assert.match(bedrock, /anthropic\/v1\/messages/);
  assert.match(bedrock, /openai\/v1\/responses/);
  assert.match(bedrock, /store: false/);
  assert.match(bedrock, /\/converse/);
  assert.match(settings, /AbortSignal\.timeout\(30_000\)/);
  assert.match(settings, /Model access unavailable\. Check the message by Test access\./);
  assert.equal(
    [...settings.matchAll(/MODEL_ACCESS_WARNING_TOAST/g)].length,
    3,
    "the short access warning should cover provider and request failures",
  );
  assert.match(settings, /aria-describedby=\{visibleModelAccess \? "model-access-detail"/);
  // Semantic toast surfaces must win in light mode. The former brand-gradient
  // override produced a blue banner with dark error text and poor hierarchy.
  assert.doesNotMatch(designSystem, /\.toast,/);
  assert.match(settingsStyles, /\.toast-error\s*\{[\s\S]*?var\(--rose\)/);
  assert.match(settingsStyles, /\.toast-warning\s*\{[\s\S]*?var\(--amber\)/);
  assert.match(settingsStyles, /\.toast-message\s*\{[\s\S]*?align-items: center;[\s\S]*?min-height: 28px;/);
  assert.doesNotMatch(settingsStyles, /\.toast-message > span\s*\{[^}]*\btransform:/);
  assert.match(settingsStyles, /\.toast-message > svg\s*\{[\s\S]*?margin-block-start: 0;/);
  assert.match(settings, /MODEL_ACCESS_WARNING_TOAST,[\s\S]*?result\.available \? "success" : "warning"/);
  assert.match(settingsStyles, /\.toast\s*\{[\s\S]*?align-items: center/);
  // Full-width selects use the same restrained press scale as other controls.
  assert.match(designSystem, /\.app-select-trigger:active:not\(:disabled\)[\s\S]*?scale\(var\(--motion-press-scale\)\)/);
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

test("pressing controls uses one shared restrained 99% scale token", async () => {
  const [controls, designSystem, foundation, workflows, reader] = await Promise.all([
    readFile(new URL("../app/components/ui/controls.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/styles/design-system.css", import.meta.url), "utf8"),
    readFile(new URL("../app/styles/foundation.css", import.meta.url), "utf8"),
    readFile(new URL("../app/styles/management-workflows.css", import.meta.url), "utf8"),
    readFile(new URL("../app/styles/reading-assistant.css", import.meta.url), "utf8"),
  ]);
  const interactiveStyles = [controls, designSystem, foundation, workflows, reader].join("\n");
  assert.match(foundation, /--motion-press-scale:\s*0\.99;/);
  assert.match(foundation, /@keyframes popover-enter/);
  assert.equal(interactiveStyles.match(/--motion-press-scale:\s*0\.99;/g)?.length, 1);
  assert.match(controls, /app-control-motion/);
  assert.match(controls, /active:scale-\[var\(--motion-press-scale\)\]/);
  assert.match(designSystem, /\.app-select-option:active:not\(:disabled\)[\s\S]*?scale\(var\(--motion-press-scale\)\)/);
  assert.match(designSystem, /\.page-size-menu\s*\{[\s\S]*?animation: popover-enter var\(--motion-fast\)/);
  assert.match(designSystem, /\.app-select-menu\s*\{[\s\S]*?animation: popover-enter var\(--motion-fast\)/);
  assert.match(controls, /data-placement=\{pos\.bottom !== undefined \? "top" : "bottom"\}/);
  assert.match(foundation, /\.app-interaction-scope :is\(button, a, \[role="button"\]\)[\s\S]*?:active:not\(:disabled\):not\(\[aria-disabled="true"\]\)[\s\S]*?scale\(var\(--motion-press-scale\)\)/);
  // The sidebar CTA is the shared action now, so it inherits the press scale with
  // everything else rather than re-declaring it.
  assert.doesNotMatch(foundation, /\.new-paper-button:active/);
  assert.match(foundation, /\.assistant-card:active[\s\S]*?scale\(var\(--motion-press-scale\)\)/);
  assert.doesNotMatch(workflows, /\.stacks-shell[^{}]*:active/);
  assert.doesNotMatch(reader, /\.reader-page[^{}]*:active/);
  assert.doesNotMatch(interactiveStyles, /scale\(0\.(?:96|97|98|985|99)\)|scale-\[0\.(?:96|97|98|985|99)\]/);
});

test("PDF metadata extraction preserves authors and reviews every conflicting field", async () => {
  const [application, adaptiveAuthors, extraction, styles] = await Promise.all([
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ui/AdaptiveAuthors.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/extract-pdf/route.ts", import.meta.url), "utf8"),
    readApplicationStyles(),
  ]);

  // The author editor is controlled during paper editing. Writing only to its
  // hidden input used to leave both the visible chips and submitted list stale.
  assert.match(application, /const \[authorNames, setAuthorNames\] = useState<string\[]>/);
  assert.match(application, /<AuthorNamesField authors=\{authors\} value=\{authorNames\} onChange=\{setAuthorNames\} \/>/);
  assert.match(application, /selected\.has\("authors"\)[\s\S]*?setAuthorNames\(metadata\.authors\)/);
  assert.match(application, /if \(value === undefined\) \{[\s\S]*?setUncontrolledNames\(update\);[\s\S]*?return;/);
  assert.match(application, /typeof update === "function" \? update\(value\) : update/);
  assert.doesNotMatch(application, /update\(names\)/);

  // A valid metadata response with no authors gets one focused title-page retry,
  // and any still-missing list is surfaced instead of silently accepted.
  assert.match(extraction, /async function recoverAuthors/);
  assert.match(extraction, /if \(!metadata\.authors\.length\)[\s\S]*?recoverAuthors/);
  assert.match(extraction, /No author list was found[\s\S]*?review the authors before saving/i);

  // Extraction differences are an explicit, keyboard-contained review dialog.
  // Each field is independently selectable, the form behind it is inert, and
  // no metadata is applied until the user confirms the selection.
  assert.match(application, /interface PendingMetadataReview/);
  assert.match(application, /role="dialog"[\s\S]*?aria-labelledby="metadata-review-title"/);
  assert.match(application, /type="checkbox"[\s\S]*?checked=\{selected\}[\s\S]*?disabled=\{!applicable\}/);
  assert.match(application, /isExtractedMetadataFieldApplicable\(change\.field, metadataReviewPaperType\)/);
  assert.match(application, /applicableSelectedFields[\s\S]*?applyExtractedMetadata/);
  assert.match(application, /Not used by the selected paper type/);
  assert.match(application, /inert=\{pendingMetadataReview \? true : undefined\}/);
  assert.match(application, /event\.key === "Escape"[\s\S]*?event\.key !== "Tab"/);
  assert.match(application, />Keep current values<\/ActionButton>/);
  assert.match(application, />\s*Apply selected\s*<\/ActionButton>/);
  assert.match(styles, /\.metadata-review-values\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.metadata-review-values\s*\{[\s\S]*?grid-template-columns: 1fr/);
  assert.match(styles, /\.metadata-review-list\s*\{[\s\S]*?padding: 6px 20px 18px/);
  assert.match(styles, /\.metadata-review-row:has\(> input:focus-visible\)/);

  // The no-author line now enters the same type scale as ordinary author names.
  assert.match(adaptiveAuthors, /className="expandable-author-list is-empty">\{emptyLabel\}/);
  assert.match(adaptiveAuthors, /emptyLabel = "No authors recorded"/);
  assert.match(styles, /\.paper-secondary-line \.expandable-author-list\s*\{[\s\S]*?font-size: var\(--type-label\)/);
  // One byline component for every surface, so a surface cannot restyle the
  // disclosure behind the hidden measurement's back: names become links only
  // where a handler is passed, and the control is the same element in both
  // states, at the end of the name run.
  assert.match(adaptiveAuthors, /export function AdaptiveAuthors\(/);
  assert.doesNotMatch(adaptiveAuthors, /AdaptiveAuthorNames|AdaptiveAuthorButtons/);
  assert.match(adaptiveAuthors, /onOpenAuthor\s*\?\s*<button type="button"/);
  assert.match(adaptiveAuthors, /if \(onOpenAuthor\) classes\.push\("is-linked"\)/);
  assert.doesNotMatch(styles, /expandable-author-buttons/);
  assert.doesNotMatch(styles, /\.reader-authors [^{]*> button/);
  assert.doesNotMatch(styles, /\.expandable-author-list \.author-toggle \{[^}]*font: inherit/);
  assert.match(styles, /\.expandable-author-list \.author-toggle \{[^}]*font-size: var\(--type-micro\)[^}]*font-weight: 700/);
  // Disclosure fitting measures complete rendered labels on every resize frame,
  // including active column drags, and commits one exact candidate count.
  assert.match(adaptiveAuthors, /Math\.floor\(container\.getBoundingClientRect\(\)\.width\)/);
  assert.match(adaptiveAuthors, /for \(let count = 0; count <= nameWidths\.length; count \+= 1\)/);
  assert.match(adaptiveAuthors, /Math\.ceil\(requiredWidth\) <= availableWidth/);
  assert.match(adaptiveAuthors, /new ResizeObserver\(requestMeasure\)/);
  // Candidates must cost exactly what the byline costs: a non-breaking
  // separator (a plain trailing space is trimmed in the hidden measure, which
  // bought one space of width per visible author) and the live toggle class,
  // so type and inline margin come from the rendered control's own rules.
  assert.match(adaptiveAuthors, /data-author-measure-separator>\{",\u00a0"\}/);
  assert.doesNotMatch(adaptiveAuthors, /\? ", " : ""/);
  assert.match(adaptiveAuthors, /className="author-toggle author-toggle-measure"/);
  assert.doesNotMatch(styles, /\.author-adaptive-measure \.author-toggle-measure\s*\{[^}]*font-size/);
  assert.doesNotMatch(adaptiveAuthors, /is-resizing-column/);
  assert.doesNotMatch(adaptiveAuthors, /scheduleFitValidation|AUTHOR_DISCLOSURE_INLINE_RESERVE/);
});

test("agent scopes one-paper reads and proposes complete paper metadata", async () => {
  const prompt = await readFile(new URL("../app/lib/feed-prompt.ts", import.meta.url), "utf8");
  assert.match(prompt, /If the user asks to read, summarize,[\s\S]*?one identified paper[\s\S]*?Do NOT call the full-library endpoint/);
  assert.match(prompt, /For an attached library paper,[\s\S]*?paper-specific metadata and file URLs/);
  assert.match(prompt, /complete ordered author list[\s\S]*?do not[\s\S]*?incomplete create proposal/i);
  assert.match(prompt, /For a preprint,[\s\S]*?canonical name of the repository[\s\S]*?Verify the repository from the source metadata[\s\S]*?never infer it from paperType alone/i);
  assert.match(prompt, /preprintId, semanticScholarId/);
  assert.doesNotMatch(prompt, /venueAcronym|arXiv-only|set both venueName/i);
  assert.doesNotMatch(prompt, /Always READ first/);
  assert.match(prompt, /buildFollowUpPrompt[\s\S]*?Current rules for this turn:[\s\S]*?PAPER_SCOPE_RULES/);
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
  // Missing-source details retain the affected paper IDs so the Doctor can
  // identify every record and open its source editor instead of showing a count.
  assert.match(doctor, /paperIdsWithoutLocalAsset: papersWithoutLocalAsset\.map\(\(paper\) => paper\.id\)/);
  assert.match(settingsView, /paperIds: storageReport\.paperIdsWithoutLocalAsset/);
  assert.match(settingsView, /Affected papers/);
  assert.match(settingsView, /Edit source/);
  assert.match(settingsView, /Venue or repository/);
  assert.match(settingsView, /Semantic Scholar ID/);
  assert.match(doctor, /DELETE FROM authors WHERE id NOT IN/);
  assert.match(doctor, /DELETE FROM venues WHERE id NOT IN/);
  assert.match(doctor, /DELETE FROM collections WHERE id NOT IN/);
  // Moving the library is implemented (consistent backup + repoint), not stubbed.
  assert.match(doctor, /async function moveLibrary/);
  assert.match(doctor, /setLibraryRoot\(target\)/);
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
  // Preprint / Semantic Scholar ids are unique (import dedup relies on it), and the
  // bootstrap creates the indexes after unlinking any pre-existing duplicates.
  assert.match(schema, /uniqueIndex\("papers_preprint_id_unique"\)/);
  assert.match(schema, /uniqueIndex\("papers_semantic_scholar_id_unique"\)/);
  assert.match(bootstrap, /CREATE UNIQUE INDEX IF NOT EXISTS papers_preprint_id_unique/);
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

test("a message that interrupts a turn carries that turn's request with it", async () => {
  const replyRoute = await readFile(new URL("../app/api/feed/snippets/[id]/reply/route.ts", import.meta.url), "utf8");
  // The interrupted turn is stopped before it answers, so both prompt builders are
  // told to cover its request: without this the earlier message got no reply ever.
  assert.match(replyRoute, /const interrupted = isFeedRunning\(id\)/);
  assert.match(replyRoute, /buildFollowUpPrompt\(\{ reply, outcomes, attachments, interrupted \}\)/);
  assert.match(replyRoute, /buildForkPrompt\(\{ reply, transcript: forkTranscript, attachments, interrupted \}\)/);
  // And the gap is recorded, so the thread explains the question with no answer.
  assert.match(replyRoute, /Stopped this turn to send the next message/);
  // An empty submission is refused before anything is stopped: killing a turn for
  // a message the route then rejects loses that turn's work for nothing.
  assert.ok(
    replyRoute.indexOf("Enter a follow-up message or attach a file.") < replyRoute.indexOf("await stopFeedAndWait(id)"),
    "the empty-submission guard must run before the interrupt",
  );
});

test("retry, fork and rewind act on the same interaction boundaries", async () => {
  const [feed, rewindRoute, retryRoute, forkRoute, history, truncate] = await Promise.all([
    readFile(new URL("../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/snippets/[id]/rewind/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/snippets/[id]/retry/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/snippets/[id]/fork/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/feed-history.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/feed-truncate.ts", import.meta.url), "utf8"),
  ]);

  // Three features, one notion of where a turn begins and ends: the selection
  // modal, a fork (which copies the selection into a new feed), and a rewind
  // (which truncates this one in place).
  assert.match(history, /export function messagesFromInteraction/);
  assert.match(history, /export function interactionsBefore/);
  assert.match(truncate, /messagesFromInteraction\(interactions, interactionId\)/);
  assert.match(forkRoute, /selectFeedHistory\(\{/);
  // A rewind and a retry are one truncation, differing only in whether the turn's own
  // message survives it, so neither route re-implements the deletion.
  assert.match(rewindRoute, /truncateFeedAt\(snippet, parsed\.data\.interactionId, \{ keepStarter: false \}\)/);
  assert.match(retryRoute, /truncateFeedAt\(snippet, parsed\.data\.interactionId, \{ keepStarter: true \}\)/);
  // The retried turn is the prompt, so it is not also in the seeded history.
  assert.match(retryRoute, /kept\.filter\(\(message\) => message\.id !== starter\.id\)/);
  assert.match(retryRoute, /resume: false/);
  // One client call posts a selection to the fork route; the modal and a turn's own
  // Fork are two entry points into it, and the turn's uses the shared helper.
  assert.match(feed, /async function createForkFromHistory\(interactionIds: string\[\], toolDetails: boolean\)/);
  assert.match(feed, /createForkFromHistory\(\[\.\.\.selectedInteractions\], includeToolDetails\)/);
  assert.match(feed, /createForkFromHistory\(interactionsBefore\(interactions, message\.id\), includeToolDetails\)/);
  assert.match(feed, /interactions\.length - interactionsBefore\(interactions, message\.id\)\.length - 1/);
  assert.match(feed, /body: JSON\.stringify\(\{ interactionId: message\.id \}\)/);
  assert.match(feed, /onRetry=\{message\.role === "user" \? \(\) => void retryTurn\(message\.id\) : undefined\}/);
  // The opening turn can be retried too: an interrupted first turn has no other way
  // back, since there is no earlier turn to rewind to.
  assert.match(feed, /onRetry=\{\(\) => void retryTurn\(OPENING_INTERACTION_ID\)\}/);
  // The session is dropped so the next reply reseeds from what is left, and the
  // agent is not resumed onto a transcript holding the removed turns.
  assert.match(truncate, /sessionId: "",/);
  // A thread can outgrow the model's window; the seeded history is therefore bounded,
  // and the failure that happens without it is explained rather than dumped raw.
  assert.match(history, /const TRANSCRIPT_BUDGET_CHARS = 120_000/);
  assert.match(history, /omitted: this thread is longer than one prompt can carry/);
});

test("uses integrated sortable table headers without a detached sort control", async () => {
  const [component, sharedTable, styles] = await Promise.all([
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ui/ResizableTable.tsx", import.meta.url), "utf8"),
    readApplicationStyles(),
  ]);
  assert.match(component, /SortableTableHeader/);
  assert.match(sharedTable, /aria-sort/);
  assert.match(sharedTable, /useResizableColumns/);
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

test("manual add paper reuses the edit-paper fields and suppresses browser autofill", async () => {
  const application = await readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8");
  // The manual tab shares the same description editors and collections picker as
  // the edit modal, not bespoke plain textareas.
  assert.match(application, /value=\{manualSummary\} onChange=\{setManualSummary\}/);
  assert.match(application, /value=\{manualAbstract\} onChange=\{setManualAbstract\}/);
  assert.match(application, /value=\{manualNotes\} onChange=\{setManualNotes\}/);
  assert.match(application, /<CollectionNamesField collections=\{collections\} value=\{manualCollectionNames\}/);
  // No plain <textarea> lingers in the manual paper form's description fields.
  assert.doesNotMatch(application, /<textarea name="abstract"/);
  assert.doesNotMatch(application, /<textarea name="summary"/);
  // Data-entry forms opt out of the browser's own form-history dropdown, which
  // otherwise stacks stale values on top of our DB-backed autocomplete.
  assert.match(application, /onSubmit=\{addManual\}[\s\S]{0,40}autoComplete="off"|autoComplete="off"[\s\S]{0,40}onSubmit=\{addManual\}/);
  assert.match(application, /className="edit-paper-modal-form" autoComplete="off"/);
});

test("code editor overlay layers stay metric-identical under form skins", async () => {
  // MarkdownCodeEditor paints text in a <pre> and takes input in a transparent
  // <textarea> stacked on it; ANY context rule that restyles the textarea's
  // metrics (padding, line-height, border, min/max-height, margin) desyncs the
  // caret and selection from the visible glyphs. Form skins must therefore
  // exclude the editor's inner textarea.
  const styles = await readApplicationStyles();
  const guard = ":not(:where(.prompt-code-editor *))";
  for (const selector of [
    `.entity-form textarea${guard}`,
    `.settings-form-grid textarea${guard}`,
    `.entity-form textarea:focus${guard}`,
    `.settings-form-grid textarea:focus${guard}`,
  ]) {
    assert.ok(styles.includes(selector), `missing editor guard on: ${selector}`);
  }
  // The old summary-field min/max-height override targeted the editor textarea.
  assert.doesNotMatch(styles, /\.summary-field textarea/);
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
  assert.match(tasks, /activeTaskKeys/);
  assert.match(tasks, /already running/);
  assert.match(application, /Generate summary ·/);
  assert.match(application, /summaryTaskKey = `summary:\$\{paper\.id\}`/);
  assert.ok((application.match(/key: summaryTaskKey/g) ?? []).length >= 2);
  assert.match(application, /disabled=\{summaryRunning\}/);
  assert.match(application, /withSummarySlot/);
  assert.match(application, /if \(saving\) return;/);
  assert.ok(application.indexOf("setSaving(true);", application.indexOf("async function submit")) < application.indexOf("checkPaperAssets(data)", application.indexOf("async function submit")));
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
  // The high-water mark is stamped with a clock-skew margin (GitHub filters
  // `since` on ITS clock) and never advances past deferred or truncated work.
  assert.match(sync, /Date\.now\(\) - 5 \* 60 \* 1000/);
  assert.match(sync, /deferredInbound = true/);
  assert.match(sync, /!truncated && !deferredInbound/);
  // Issue/comment links are repo-scoped: switching repos unlinks every feed,
  // message, and proposal first, and restarts from a full (non-since) sweep.
  assert.match(settingsLib, /linkedRepo/);
  assert.match(sync, /readGithubLinkedRepo/);
  assert.match(sync, /writeGithubLinkedRepo/);
  assert.match(sync, /issueNumber: null, issueTitleSynced: null, issueStateSynced: null/);
  assert.match(sync, /githubCommentId: null, attachmentsSynced: 0/);
  assert.match(sync, /linkedRepo === repo \? readGithubLastSyncedAt\(\) : undefined/);
  // Ingested comment batches keep their GitHub order (distinct timestamps).
  assert.match(sync, /new Date\(now \+ index\)\.toISOString\(\)/);
  // The attachment backfill probe runs once per message, not on every sync.
  assert.match(sync, /attachmentsSynced/);
  assert.match(sync, /message\.attachmentsSynced\) continue/);
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
  // Large libraries are drained as resumable write batches. GitHub mutations
  // are globally serial, spaced by its recommended one-second interval, and
  // the client keeps requesting checkpointed passes instead of bursting them.
  assert.match(client, /const MIN_MUTATION_INTERVAL_MS = 1_000/);
  assert.match(client, /createGitHubSyncPolicy/);
  assert.match(client, /queueMutation/);
  assert.match(sync, /error instanceof GitHubSyncDeferred/);
  assert.match(sync, /pauseReason: error\.reason/);
  assert.match(feed, /data\.pauseReason === "cooldown"/);
  assert.match(feed, /while \(true\)[\s\S]*?fetch\("\/api\/feed\/github\/sync"/);
  // Collapsing a feed closes its issue on sync (reopened when expanded), tracked
  // by a 3-way base so the API is only called on a real state change.
  assert.match(client, /patchIssueState/);
  assert.match(sync, /issueStateSynced/);
  assert.match(sync, /issuesClosed/);
  // Close/reopen is bidirectional: the inbound list covers ALL issue states so
  // a phone-side close/reopen is adopted as the local collapsed flag and
  // comments on closed (collapsed) issues still sync. Closed UNLINKED issues
  // never become feeds (that would resurrect deleted ones).
  assert.match(client, /state=all/);
  assert.doesNotMatch(client, /state=open/);
  assert.match(sync, /issue\.state !== \(feed\.issueStateSynced \?\? "open"\)/);
  assert.match(sync, /if \(issue\.state !== "open"\) continue/);
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
  assert.match(sync, /await flushGithubOutbox\(config\)/);
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

test("the GitHub sync survives a deleted issue, a repeated issue, and a long thread", async () => {
  const [sync, client] = await Promise.all([
    readFile(new URL("../app/api/feed/github/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/github-sync.ts", import.meta.url), "utf8"),
  ]);
  // A feed whose issue was deleted upstream 404s on every outbound call. That used
  // to escape to the route as a 400, so no later feed was processed at all.
  assert.match(sync, /error\.status === 404 \|\| error\.status === 410/);
  assert.match(sync, /feedsUnlinked \+= 1/);
  // Updated-sort pagination can return one issue twice; inserting it twice hit the
  // unique index on issue_number and aborted the sync.
  assert.match(sync, /const handled = new Set<number>\(\)/);
  // A thread longer than the page cap was read as complete, so the high-water mark
  // advanced past comments that were never ingested.
  assert.match(client, /export async function listCommentsPaged/);
  assert.match(sync, /commentsTruncated/);
  // The stored title and its 3-way base must be the same string, or every later
  // sync sees a phantom local rename and pushes the truncation to GitHub.
  assert.match(sync, /issueTitleSynced: localTitle/);
  assert.doesNotMatch(sync, /issueTitleSynced: issue\.title\b/);
  // A repo segment of ".." would collapse the pinned /repos/owner/name path.
  assert.match(client, /segment === "\." \|\| segment === "\.\."/);
});

test("the GitHub sync recovers linked comments that fell behind its cursor", async () => {
  const [sync, feed] = await Promise.all([
    readFile(new URL("../app/api/feed/github/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
  ]);
  // The issue-level `since` query is only a change-discovery optimization. Every
  // linked issue omitted by that result still gets a complete comment-id sweep,
  // so an unseen comment older than the cursor cannot remain hidden forever.
  assert.match(sync, /const reconcileComments = async[\s\S]*?listCommentsPaged\(config, issueNumber\)/);
  assert.match(sync, /for \(const \[issueNumber, feed\] of linked\) \{\s*if \(handled\.has\(issueNumber\)\) continue;\s*await reconcileLinkedComments\(issueNumber, feed\);/);
  // Issues present in the incremental response use the same reconciliation path,
  // keeping deduplication, edit adoption, and agent launch behavior identical.
  assert.match(sync, /await reconcileLinkedComments\(issue\.number, feed\);/);
  assert.match(sync, /!localByComment\.has\(comment\.id\)/);
  // The anti-entropy sweep must finish before the high-water mark advances.
  assert.ok(sync.indexOf("for (const [issueNumber, feed] of linked)") < sync.indexOf("writeGithubLastSyncedAt(startedAt)"));
  // GitHub sync starts the turn outside FeedDetail. A finished thread's previous
  // SSE connection is already closed, so the running transition must reconnect
  // it to replay the imported user message and subscribe to the agent response.
  assert.match(feed, /const streamVersion = `\$\{streamNonce\}:\$\{running \? "running" : "idle"\}`/);
  assert.match(feed, /new EventSource\(`\/api\/feed\/snippets\/\$\{snippet\.id\}\/events`\)[\s\S]*?\}, \[snippet\.id, streamVersion\]\);/);
  // Opening a long feed receives persisted history atomically, stays pinned until
  // that snapshot settles, and observes the stable content wrapper so later live
  // events cannot strand the viewport in the middle of the conversation.
  assert.match(feed, /const replayingHistoryRef = useRef\(true\)/);
  assert.match(feed, /source\.addEventListener\("snapshot"/);
  assert.match(feed, /observer\.observe\(content\)/);
  assert.match(feed, /source\.addEventListener\("status", completeReplay\)/);
  assert.match(feed, /const userScrollIntentRef = useRef\(false\)/);
  assert.match(feed, /else if \(!replayingHistoryRef\.current && userScrollIntentRef\.current\) pinnedToBottomRef\.current = false/);
});

test("tooltips are drawn by the app, not the browser", async () => {
  const [layer, reader, styles, layout] = await Promise.all([
    readFile(new URL("../app/components/ui/TooltipLayer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ReaderWorkspace.tsx", import.meta.url), "utf8"),
    readApplicationStyles(),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);
  // Mounted once for the whole app, so every existing title="..." is covered
  // without touching its call site.
  assert.match(layout, /<TooltipLayer \/>/);
  // It listens at the document level and portals a fixed-position element, which is
  // what lets a tooltip escape a scroll container or modal clip.
  assert.match(layer, /addEventListener\("pointerover"/);
  assert.match(layer, /createPortal/);
  // The native bubble is suppressed by moving the text aside during hover, and the
  // attribute is always restored (including on unmount) so assistive tech keeps it.
  assert.match(layer, /removeAttribute\("title"\)/);
  assert.match(layer, /setAttribute\("title", text\)/);
  assert.match(layer, /const restore = /);
  // Keyboard focus shows it too, not just the pointer.
  assert.match(layer, /addEventListener\("focusin"/);
  assert.match(layer, /role="tooltip"/);
  // Accessibility-only titles can explicitly opt out of visual hover help. The
  // PDF iframe keeps its required accessible name without covering the page in
  // a tooltip containing its generated local filename.
  assert.match(layer, /closest\("\[data-tooltip-disabled\]"\)/);
  assert.match(reader, /className="reader-document"[\s\S]*?data-tooltip-disabled/);
  // Styled from the theme tokens, so it inverts with light/dark instead of looking
  // like the operating system.
  assert.match(styles, /\.app-tooltip \{/);
  assert.match(styles, /background: var\(--ink\)/);
  assert.match(styles, /max-width: 320px/);
});

test("paper details open as an accessible modal instead of a side drawer", async () => {
  const [application, styles] = await Promise.all([
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
    readApplicationStyles(),
  ]);
  assert.match(application, /className="detail-drawer"[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"[\s\S]*?aria-labelledby=\{detailTitleId\}/);
  assert.match(application, /return createPortal\(dialog, document\.body\)/);
  assert.match(application, /function ModalFrame[\s\S]*?return createPortal\(\([\s\S]*?document\.body\)/);
  assert.match(application, /appShellRef\.current\.inert = !suspendAutoClose/);
  assert.match(application, /event\.key === "Escape"/);
  assert.match(application, /event\.key === "Tab"/);
  assert.match(application, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(application, /role="tablist"/);
  assert.match(application, /role="tabpanel"/);
  assert.match(styles, /\.detail-drawer \{[\s\S]*?left: 50%;[\s\S]*?top: 50%;[\s\S]*?transform: translate\(-50%, -50%\)/);
  assert.match(styles, /\.modal-layer \{[\s\S]*?z-index: 90/);
  assert.match(styles, /\.paper-detail-tab-panel \{[\s\S]*?max-height:[\s\S]*?overflow-y: auto/);
  assert.match(styles, /\.paper-detail-tab-panel\.is-notes \{[\s\S]*?flex: 1;[\s\S]*?max-height: none/);
  assert.match(styles, /\.paper-detail-tab-panel\.is-notes \.prompt-code-editor \{[\s\S]*?flex: 1;[\s\S]*?height: auto/);
  assert.doesNotMatch(styles, /\.drawer-layer > \.drawer-scrim \{[\s\S]*?display: none/);
});

test("venue monograms fit their chip and stay centred in it", async () => {
  const [application, styles] = await Promise.all([
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
    readApplicationStyles(),
  ]);

  // Four uppercase glyphs are what makes a venue chip recognizable (COLM, AAAI),
  // so the chip drops a type step instead of dropping a letter. Tracking stays
  // at normal because letter-spacing trails the last glyph too, which pulls the
  // centred acronym off centre, and 1.3 is this font's ascent plus descent, so
  // the line box has no leading left to round the caps off the chip's middle.
  assert.match(application, /function venueMonogram[\s\S]*?\.slice\(0, 4\)/);
  assert.match(styles, /--type-nano: 10px/);
  assert.match(styles, /\.entity-research-grid \.venue-monogram \{[^}]*font-size: var\(--type-nano\)/);
  assert.match(styles, /\.entity-research-grid \.venue-monogram \{[^}]*line-height: 1\.3/);
  assert.doesNotMatch(styles, /\.entity-research-grid \.venue-monogram \{[^}]*letter-spacing: -/);
  assert.match(styles, /\.entity-research-grid \.venue-monogram \{[\s\S]*?align-items: center[\s\S]*?justify-content: center/);

});

test("feed figures and tables size to their content and stay centred", async () => {
  const [mermaid, styles] = await Promise.all([
    readFile(new URL("../app/components/MermaidDiagram.tsx", import.meta.url), "utf8"),
    readApplicationStyles(),
  ]);

  // Feed figures size to their content, not to a fraction of the message. Mermaid
  // writes width="100%" on its SVG, which contributes nothing to a shrink-to-fit
  // box (every diagram then rendered at the 300px default of a replaced element),
  // so the viewBox becomes the SVG's intrinsic size: the block hugs a small
  // diagram and a large one scales down to the measure.
  assert.match(mermaid, /function withIntrinsicSize/);
  assert.match(mermaid, /viewBox="\(\[\^"\]\+\)"/);
  assert.match(mermaid, /<svg width="\$\{width\}" height="\$\{height\}"/);
  assert.match(mermaid, /"--diagram-natural-width": `\$\{state\.diagram\.width\}px`/);
  assert.match(styles, /\.mermaid-diagram-canvas > svg \{[^}]*margin-inline: auto/);
  assert.match(styles, /\.mermaid-diagram-canvas > svg \{[^}]*height: auto/);
  assert.doesNotMatch(styles, /\.mermaid-diagram \{[^}]*width: 100%/);

  // Scaling a diagram to fit shrinks its 16px labels with it, so the floor is
  // 0.7 (11px, the app's smallest text) and a wider diagram scrolls inside the
  // canvas. The scroll must stay off the block, which is what the own-window
  // action is positioned against.
  assert.match(styles, /\.mermaid-diagram-canvas > svg \{[^}]*min-width: calc\(var\(--diagram-natural-width, 0px\) \* 0\.7\)/);
  assert.match(styles, /\.mermaid-diagram-canvas \{[^}]*max-height: 70vh[^}]*overflow: auto/);
  assert.doesNotMatch(styles, /\.mermaid-diagram \{[^}]*overflow: auto/);

  // Tables wrap into more rows rather than pushing every row onto one scrolling
  // line, and a table narrower than the message stays centred in it.
  assert.match(styles, /\.markdown-content \.markdown-table-scroll table \{[^}]*width: auto/);
  assert.doesNotMatch(styles, /\.markdown-content \.markdown-table-scroll table \{[^}]*width: max-content/);
  assert.match(styles, /\.feed-rich-table \{[^}]*margin-inline: auto[^}]*width: fit-content/);
  assert.match(styles, /\.markdown-media \{[^}]*margin: 0\.9em auto[^}]*width: fit-content/);
});

test("each feed turn ends with its own time and the turn's measured usage", async () => {
  const [feed, agent, events, schema, bootstrap, styles] = await Promise.all([
    readFile(new URL("../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/feed-agent.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/snippets/[id]/events/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
    readApplicationStyles(),
  ]);

  // The CLI reports usage once per turn, in the result event. It is accumulated
  // onto the feed (the header totals) and stamped on the message that turn ends
  // with, which is what lets a reply show its own tokens and speed. A retry's
  // failed attempt is still excluded from both.
  assert.match(schema, /inputTokens: integer\("input_tokens"\).notNull\(\).default\(0\)/);
  assert.match(schema, /durationMs: integer\("duration_ms"\).notNull\(\).default\(0\)/);
  assert.match(bootstrap, /for \(const column of \["input_tokens", "output_tokens", "duration_ms"\]\)[\s\S]*?ALTER TABLE feed_messages ADD COLUMN \$\{column\} INTEGER NOT NULL DEFAULT 0/);
  assert.match(agent, /function turnUsage\(event: Record<string, unknown>\): TurnUsage \| null/);
  assert.match(agent, /const usage = willRetry \? null : turnUsage\(event\)/);
  assert.match(agent, /if \(usage && resultMessageId\) \{\s*await recordMessageUsage\(resultMessageId, usage\)/);
  assert.match(events, /inputTokens: message\.inputTokens,\s*outputTokens: message\.outputTokens,\s*durationMs: message\.durationMs/);

  // The footer sits after the reply, not beside the eyebrow: local date and time
  // first, then speed, tokens, and elapsed time. Speed and tokens are only shown
  // when the turn actually reported them, so older threads show the time alone.
  assert.match(feed, /function fullTime[\s\S]*?toLocaleString\("en", \{ dateStyle: "medium", timeStyle: "short" \}\)/);
  assert.match(feed, /<time className="feed-turn-metric" dateTime=\{iso\}>\{fullTime\(iso\)\}<\/time>/);
  assert.match(feed, /\{speed \? <span className="feed-turn-metric">\{formatSpeed\(speed\)\} tok\/sec<\/span> : null\}/);
  assert.match(feed, /outputTokens && durationMs \? outputTokens \/ \(durationMs \/ 1000\) : 0/);
  assert.match(feed, /<TurnMeta\s+iso=\{snippet\.createdAt\}/);
  assert.match(feed, /<TurnMeta\s+iso=\{message\.createdAt\}\s+message=\{message\}/);
  // Provenance, not content: dot-separated text with no chip chrome around it.
  assert.match(styles, /\.feed-turn-meta \{[^}]*font-variant-numeric: tabular-nums/);
  assert.match(styles, /\.feed-turn-metric \+ \.feed-turn-metric::before \{[^}]*content: "·"/);
  assert.doesNotMatch(styles, /\.feed-turn-metric \{[^}]*border-radius/);
  // Usage lands after its message was streamed, so a live thread is told about it
  // rather than showing the turn's cost only after a reload.
  assert.match(agent, /\| \{ type: "usage"; messageId: string/);
  assert.match(agent, /emit\(snippetId, \{\s*type: "usage",\s*messageId: resultMessageId/);
  assert.match(feed, /source\.addEventListener\("usage"/);
  assert.match(feed, /message\.id === usage\.messageId/);
});

test("no ingest path can store a body that stopped early", async () => {
  const [localFiles, extractRoute, application, config, pdfText] = await Promise.all([
    readFile(new URL("../app/lib/local-files.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/extract-pdf/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/pdf-text.ts", import.meta.url), "utf8"),
  ]);

  // The cut came from the framework: proxy.ts matches /api/:path*, so Next clones
  // each API body and caps it at experimental.proxyClientMaxBodySize, which
  // defaults to 10 MiB and ends the stream cleanly rather than erroring. A 41 MB
  // PDF was stored as 10,470,576 bytes with a 200 response.
  assert.match(config, /proxyClientMaxBodySize: "150mb"/);
  assert.match(config, /cuts it at this limit/);

  // And the routes no longer trust a clean end of stream, whatever the cause.
  assert.match(localFiles, /if \(declaredLength > 0 && received !== declaredLength\) \{/);
  assert.match(localFiles, /The upload stopped early/);
  assert.match(localFiles, /!response\.headers\.get\("content-encoding"\) && received !== declaredLength/);
  assert.match(localFiles, /the download stopped early/);
  assert.match(extractRoute, /bytes\.length !== declaredLength/);
  // The reported success cannot outrun the bytes: the route returns what it wrote.
  assert.match(localFiles, /bytes: contents\.length/);
  assert.equal([...application.matchAll(/bytes were stored, so the (?:import|copy) was stopped/g)].length, 2);
  // A stored asset means bytes on disk, not just an inode.
  assert.match(localFiles, /info\?\.isFile\(\) && info\.size > 0/);
  // One malformed page still costs only that page.
  assert.match(pdfText, /skippedPages\.push\(pageNumber\)/);
});

test("a summary says what it was written from, and quotes read as one shape", async () => {
  const [summarizeRoute, application, prompts, extractRoute, review, libraryRoute, bootstrap, styles] = await Promise.all([
    readFile(new URL("../app/api/summarize/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/ai-prompts.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/extract-pdf/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/metadata-review.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/library/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
    readApplicationStyles(),
  ]);

  // The route already knew whether it had the paper's text; nothing reported it, so
  // a review written from the abstract alone looked like one written from the paper.
  assert.match(summarizeRoute, /interface PaperGrounding/);
  assert.match(summarizeRoute, /source: "pdf" \| "webpage" \| "none"/);
  assert.match(summarizeRoute, /source: grounding\.source/);
  assert.match(summarizeRoute, /pagesSkipped/);
  assert.match(application, /function groundingNote/);
  assert.match(application, /could not be parsed/);
  assert.match(application, /log\.step\(groundingNote\(payload\.grounding\)\)/);
  assert.match(application, /log\.step\(groundingNote\(generated\.grounding\)\)/);
  assert.match(application, /summarySavedMessage\(payload\.grounding\)/);
  assert.match(application, /written from the record's metadata/);

  // The field the extractor kept filling with invented topic labels is the source's
  // own subject class, which is what the BibTeX export writes as eprintclass.
  // The extractor is not asked for a subject class at all: it has no source for one
  // (no provider ingest path carries it, not even arXiv's feed parser), so the field
  // it was asked to fill came out as invented topics.
  assert.doesNotMatch(prompts, /"category"/);
  assert.doesNotMatch(extractRoute, /category/);
  assert.doesNotMatch(review, /"category"/);
  // The field itself stays: a person can still type a real class on an arXiv paper.
  assert.match(application, /<b>Category<\/b>/);
  assert.match(application, /<input name="category"[^>]*placeholder="cs\.CL"/);
  // And it is arXiv-only, enforced on write rather than trusted from the payload.
  assert.match(libraryRoute, /function isArxivRecord/);
  assert.match(libraryRoute, /\}\) \? cleanString\(data\.category\) : null/);
  assert.match(libraryRoute, /if \(!isArxivRecord\(effective\)\) \{\s*assignments\.category = null/);
  assert.match(bootstrap, /UPDATE papers SET category = NULL WHERE category IS NOT NULL/);

  // The quote block is a well like the app's other Markdown blocks, with the accent
  // as an inset rule so it follows the corner, and no fixed colour literals.
  assert.match(styles, /\.markdown-content blockquote \{[^}]*border-radius: var\(--radius-md\)/);
  // No accent edge at all: a straight bar down one side of a rounded box reads as a
  // fault whether it is a border (which squares the corners) or an inset rule
  // (which floats inside them). The well itself marks the quotation.
  assert.doesNotMatch(styles, /\.markdown-content blockquote \{[^}]*box-shadow/);
  assert.doesNotMatch(styles, /\.markdown-content blockquote \{[^}]*border-left/);
  assert.match(styles, /\.markdown-content blockquote \{[^}]*color: color-mix\(in srgb, var\(--muted\) 78%, var\(--ink\)\)/);
  assert.doesNotMatch(styles, /border-radius: 0 var\(--radius-md\) var\(--radius-md\) 0/);
  assert.doesNotMatch(styles, /\[data-theme="light"\] \.markdown-content blockquote/);
  assert.match(styles, /\.markdown-content blockquote > :first-child \{[^}]*margin-top: 0/);
  assert.match(styles, /\.feed-turn-user \.feed-bubble blockquote \{[^}]*border-color: rgba\(255, 255, 255/);
  assert.doesNotMatch(styles, /\.feed-turn-user \.feed-bubble blockquote \{[^}]*box-shadow/);
});

test("a reply that hit the token ceiling is not presented as finished", async () => {
  const [bedrock, schemas, summarizeRoute, extractRoute] = await Promise.all([
    readFile(new URL("../app/lib/bedrock.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/schemas/bedrock.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/summarize/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/extract-pdf/route.ts", import.meta.url), "utf8"),
  ]);

  // Every endpoint says why it stopped; the schemas simply never read it, so a review
  // cut off at the max-tokens ceiling was saved exactly like a finished one.
  assert.match(schemas, /stop_reason: z\.string\(\)\.nullish\(\)/);
  assert.match(schemas, /stopReason: z\.string\(\)\.nullish\(\)/);
  assert.match(schemas, /incomplete_details: z\.object\(\{ reason/);
  assert.match(bedrock, /truncated: boolean/);
  assert.match(bedrock, /truncated: payload\.data\.stop_reason === "max_tokens"/);
  assert.match(bedrock, /truncated: payload\.data\.stopReason === "max_tokens"/);
  assert.match(bedrock, /incomplete_details\?\.reason === "max_output_tokens"/);

  // The summary is refused rather than stored half-written, and it names the ceiling
  // and where to raise it.
  assert.match(summarizeRoute, /if \(result\.truncated\) \{/);
  assert.match(summarizeRoute, /token ceiling and stopped mid-answer, so it was not saved/);
  assert.match(summarizeRoute, /Raise "Max tokens" in Settings/);
  // Extraction says the reply was cut off instead of blaming the JSON it produced.
  assert.equal([...extractRoute.matchAll(/if \(result\.truncated\)/g)].length, 2);
  assert.match(extractRoute, /token ceiling for this step and was cut off/);
});

test("colour means reading status, and nothing else", async () => {
  const [styles, application] = await Promise.all([
    readApplicationStyles(),
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
  ]);
  // The recent-papers tile was painted by paper type with the very tokens the status
  // pills use (--amber is --status-inbox, --cyan is --status-reading), so an amber
  // tile meaning "preprint" sat beside an amber pill meaning "to read".
  assert.doesNotMatch(styles, /\.type-journal|\.type-preprint/);
  assert.doesNotMatch(application, /type-\$\{paper\.paperType\}/);
  assert.match(application, /className="type-tile"/);
  assert.match(styles, /\.type-tile \{[^}]*background: var\(--brand-blue-soft\)/);
});

test("both managed directories number duplicate filenames the same way", async () => {
  const [localFiles, attachments] = await Promise.all([
    readFile(new URL("../app/lib/local-files.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/feed-attachments.ts", import.meta.url), "utf8"),
  ]);
  // The library numbered from -2 and the feed's attachment staging from -1, so the
  // same collision produced a different name depending on the path that stored it.
  assert.match(localFiles, /export function nextFreeName/);
  assert.match(localFiles, /return nextFreeName\(targetDirectory, stem, extension\)/);
  assert.match(attachments, /import \{ nextFreeName \} from "@\/app\/lib\/local-files"/);
  assert.match(attachments, /return nextFreeName\(dir, stem, ext\)/);
  assert.doesNotMatch(attachments, /let counter = 1/);
});

test("a Doctor repair button performs the repair it names", async () => {
  const settings = await readFile(new URL("../app/components/SettingsView.tsx", import.meta.url), "utf8");

  // The action button used to render whenever the modal listed records and always
  // called removeOrphans, so opening it from Unlinked assets ran the database
  // repair (clean-orphans) and deleted no files, while reporting success.
  assert.match(settings, /repair\?: "orphaned-records" \| "unlinked-files"/);
  assert.match(settings, /records: orphanList, repair: "orphaned-records"/);
  assert.match(settings, /repair: "unlinked-files"/);
  assert.match(settings, /doctorModal\.repair === "orphaned-records" \?[\s\S]*?removeOrphans\(\)/);
  assert.match(settings, /doctorModal\.repair === "unlinked-files" \?[\s\S]*?cleanStorage\(\)/);
  assert.doesNotMatch(settings, /doctorModal\.records \?\s*\(\s*<ActionButton/);
  // It closes only when files were actually removed, so a cancelled confirmation
  // leaves the list on screen.
  assert.match(settings, /async function cleanStorage\(\): Promise<boolean>/);
  assert.match(settings, /cleanStorage\(\)\.then\(\(cleaned\) => \{ if \(cleaned\) setDoctorModal\(null\)/);
  // And the modal no longer points at a button somewhere else on the page.
  assert.doesNotMatch(settings, /Use "Clean unlinked assets" below/);
});

test("every button is one family: capsule, gradient to the edge, one shadow", async () => {
  const [controls, application, styles] = await Promise.all([
    readFile(new URL("../app/components/ui/controls.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Stacks.tsx", import.meta.url), "utf8"),
    readApplicationStyles(),
  ]);

  // A fixed 16px corner reads as a pill on a 34px button and as a rounded rectangle
  // on a 48px one, so two buttons side by side looked like different families. Text
  // buttons are capsules at every height; icon buttons stay squircles.
  assert.match(controls, /large: "h-11 rounded-full/);
  assert.match(controls, /medium: "h-10 rounded-full/);
  assert.match(controls, /small: "h-\[34px\] rounded-full/);
  assert.match(controls, /icon: "size-10 rounded-\[var\(--radius-lg\)\]/);
  assert.doesNotMatch(controls, /"app-control-motion[\s\S]{0,120}rounded-\[var\(--radius-lg\)\] border/);

  // The brand gradient runs edge to edge: a flat white border sat over blue at one
  // end and violet at the other, which read as a mismatched outline.
  assert.match(controls, /primary: \[\s*"border-transparent bg-\[image:var\(--brand-gradient\)\]/);
  assert.doesNotMatch(controls, /hover:border-white\/20/);

  // The hand-rolled copies of the primary button are gone: the sidebar CTA and the
  // Discover search button are the shared action, so neither can drift to its own
  // height, shadow, or shape again.
  assert.match(application, /className="new-paper-button"[\s\S]*?kbd="N"/);
  assert.doesNotMatch(styles, /\.new-paper-button \{[^}]*background-image/);
  assert.doesNotMatch(styles, /\.new-paper-button \{[^}]*box-shadow/);
  assert.doesNotMatch(styles, /\.discover-search-box > button \{[^}]*height: 48px/);
  assert.doesNotMatch(styles, /\.discover-search-box > button,\s*\.modal-results/);
  assert.match(styles, /\.discover-search-box > button \{[^}]*min-width: 118px/);

  // Text buttons that sit beside the family take its shape too, wherever they are
  // hand-rolled: the eyebrow Regenerate, the field-label Regenerate, the toolbar
  // Filters toggle, and the sort reset.
  for (const selector of [".eyebrow-generate", ".field-label-action > button", ".filter-builder-toggle", ".sort-reset-button"]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(styles, new RegExp(`${escaped} \\{[^}]*border-radius: var\\(--radius-pill\\)`), `${selector} should be a capsule`);
  }
  // A card's own metadata rules must not reach the label inside a button: these
  // repainted the Add button's label muted 11px text on its gradient.
  assert.match(styles, /\.modal-results span:not\(:where\(button \*\)\)/);
  assert.doesNotMatch(styles, /\.modal-results span \{/);

  // The composer's grip sits on the panel's own border, so a partial alpha let the
  // border show straight through the pill.
  assert.match(styles, /\.feed-dock-input:hover \.feed-panel-resize-handle,[\s\S]*?opacity: 1/);
  assert.match(styles, /\.feed-panel-resize-handle:hover \{[^}]*background: color-mix\(in srgb, var\(--brand-blue\) 10%/);
});

test("a proposal can rename a collection and edit its membership", async () => {
  const [libraryRoute, prompt] = await Promise.all([
    readFile(new URL("../app/api/library/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/feed-prompt.ts", import.meta.url), "utf8"),
  ]);

  // A collection can be renamed and its membership edited without restating it:
  // paperIds reconciles to an exact set, which silently drops every paper a caller
  // omits, so an agent that only knows what to add needs a delta. Both, and the
  // fields each entity accepts, are documented where the agent will read them.
  assert.match(libraryRoute, /function editCollectionPapers/);
  assert.match(libraryRoute, /editCollectionPapers\(tx, id, data\.addPaperIds, data\.removePaperIds\)/);
  assert.match(prompt, /collection: name \(this is how you RENAME a collection\)/);
  assert.match(prompt, /addPaperIds\[\] \/ removePaperIds\[\]/);
  assert.match(prompt, /paperIds\[\]: the complete membership, REPLACING it/);
  // An update used to drop semanticScholarId even though a create stores it.
  assert.match(libraryRoute, /const paperTextFields = \{[\s\S]*?semanticScholarId: papers\.semanticScholarId/);

});

test("the user's decisions reach the agent exactly once", async () => {
  const [outcomes, resolveRoute, replyRoute, syncRoute, agent, bootstrap, schema] = await Promise.all([
    readFile(new URL("../app/lib/feed-outcomes.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/proposals/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/snippets/[id]/reply/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feed/github/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/feed-agent.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);

  // A decision is recorded in the thread and handed to the agent: once, promptly,
  // and coalesced, so approving a batch is one turn rather than one turn each.
  assert.match(schema, /reportedAt: text\("reported_at"\)/);
  assert.match(bootstrap, /ADD COLUMN reported_at TEXT/);
  assert.match(bootstrap, /UPDATE feed_proposals SET reported_at = COALESCE\(resolved_at, CURRENT_TIMESTAMP\) WHERE status <> 'pending'/);
  assert.match(resolveRoute, /async function recordDecision/);
  assert.match(resolveRoute, /scheduleOutcomeReport\(snippetId\)/);
  assert.match(resolveRoute, /Approved and applied: \$\{summary\}/);
  assert.match(resolveRoute, /Rejected: \$\{storedProposalSummary\(proposal\.operation, "a change"\)\}/);
  assert.match(outcomes, /const COALESCE_MS = 1500/);
  assert.match(outcomes, /if \(isFeedRunning\(snippetId\)\) return/);
  assert.match(outcomes, /isNull\(feedProposals\.reportedAt\)/);
  // A turn that was running when the decision was taken reports it when it ends.
  assert.match(agent, /import\("@\/app\/lib\/feed-outcomes"\)[\s\S]*?scheduleOutcomeReport\(snippetId\)/);
  // Reply and inbox-comment turns carry only what has not been reported yet, so
  // the same approvals stop being repeated in every later prompt.
  assert.match(replyRoute, /const outcomes = await unreportedOutcomes\(id\)/);
  assert.match(replyRoute, /await markOutcomesReported\(outcomes\.ids\)/);
  assert.match(syncRoute, /const outcomes = await unreportedOutcomes\(feed\.id\)/);
  assert.doesNotMatch(replyRoute, /status === "applied"\)\.map/);
});

test("the approval block reads like a tool call and names what it targets", async () => {
  const [feed, styles] = await Promise.all([
    readFile(new URL("../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
    readApplicationStyles(),
  ]);

  // Proposals take their place in the thread by time. A proposal the agent posted
  // through the API is anchored to a tool_use message, which renders inside a
  // collapsed tool group, so those used to sink to a trailing block: a resolved
  // change then sat below newer pending ones.
  assert.match(feed, /const floatingProposals = proposals/);
  assert.match(feed, /flushFloatingProposals\(message\.createdAt\)/);
  assert.match(feed, /flushFloatingProposals\(null\)/);
  assert.doesNotMatch(feed, /props-unanchored/);

  // The block folds like a tool call, open while a decision is outstanding. The
  // open state is React state because the thread re-renders on every poll, which
  // would otherwise snap a block the reader just opened shut again.
  assert.match(feed, /<details\s+className="feed-proposals"[\s\S]*?open=\{proposalBlockOpen\[key\] \?\? pendingHere > 0\}/);
  assert.match(feed, /setProposalBlockOpen/);
  assert.match(styles, /\.feed-proposals \{[^}]*box-shadow: var\(--edge-highlight\)/);
  assert.match(styles, /\.feed-proposals\[open\] \.feed-proposals-head \{[^}]*border-bottom/);

  // A stored id names nothing, so the target and any id-valued field resolve to
  // the record's own name, with the id kept as secondary text.
  assert.match(feed, /function describeProposalTarget/);
  assert.match(feed, /const collectionsById = new Map/);
  assert.match(feed, /const ID_FIELDS = new Set\(\["paperIds", "addPaperIds", "removePaperIds", "collectionIds"\]\)/);
  assert.match(feed, /fieldValue\(value, ID_FIELDS\.has\(key\) \? describeTarget : undefined\)/);
  assert.match(styles, /\.feed-proposal-target-meta/);
});

test("a user's Markdown stays legible on the blue bubble", async () => {
  const styles = await readApplicationStyles();
  // Headings, quotes, tables, and math each declare an ink-dark colour, which the
  // bubble's own white cannot override through inheritance: they rendered as black
  // text on the gradient. A line of "=" under any line makes a heading, so this is
  // easy to hit by accident in a pasted request.
  assert.match(styles, /\.feed-turn-user \.feed-bubble :is\(h1, h2, h3, h4, h5, h6, blockquote, th, td, \.katex\) \{[^}]*color: inherit/);
  assert.match(styles, /\.feed-turn-user \.feed-bubble blockquote \{[^}]*background: rgba\(255, 255, 255/);
  assert.match(styles, /\.feed-turn-user \.feed-bubble \.markdown-table-scroll th \{[^}]*background: rgba\(255, 255, 255/);
  // The dark declarations these override are the shared Markdown rules.
  assert.match(styles, /\.markdown-content h1,[\s\S]*?color: var\(--ink\)/);
});

test("the feed composer reads as one control, with a visible placeholder", async () => {
  const [attachBox, feed, styles] = await Promise.all([
    readFile(new URL("../app/components/feed/AttachBox.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
    readApplicationStyles(),
  ]);

  // Attachments live inside the composer frame, above the text and under the same
  // focus ring, instead of in a second bordered panel floating above it.
  assert.match(attachBox, /is-panel-resizable[\s\S]*?feed-attach-tray[\s\S]*?<MarkdownCodeEditor/);
  assert.match(styles, /\.feed-attach-tray \{[^}]*border-bottom: 1px solid var\(--line\)/);
  assert.doesNotMatch(styles, /\.feed-attach-tray \{[^}]*background:/);

  // The newline reminder stays on the row (it is the one shortcut that is not
  // guessable from the ↵ badge), and the button repeats both in its tooltip.
  assert.match(attachBox, /\{hint \? <span className="feed-dock-hint">\{hint\}<\/span> : null\}/);
  assert.match(styles, /\.feed-dock-hint \{[^}]*font-size: var\(--type-caption\)/);
  assert.equal([...feed.matchAll(/hint=\{<><kbd>⌥↵<\/kbd> newline<\/>\}/g)].length, 2);
  assert.match(attachBox, /title="Enter sends, Option Enter starts a newline"/);

  // The composer is resizable by pointer and keyboard, and the grip fades in with
  // the composer instead of waiting for the pointer to find a pill on its edge.
  // Its floor has to match the CSS floor, or a drag cannot reach the resting size.
  assert.match(attachBox, /const minimumPanelHeight = compact \? 128 : 210/);
  assert.match(styles, /\.feed-dock-input\.is-panel-resizable \{[^}]*min-height: 128px/);
  assert.match(styles, /\.feed-dock-input:hover \.feed-panel-resize-handle,\s*\.feed-dock-input:focus-within \.feed-panel-resize-handle \{[^}]*opacity: 1/);
  assert.match(attachBox, /if \(event\.key === "Home"\) setPanelHeight\(null\)/);
  assert.match(attachBox, /role="separator"[\s\S]*?aria-valuenow=/);
  // Attach controls and truncated chips say what they are on hover (one shared
  // TooltipLayer picks up every title).
  assert.match(attachBox, /title="Attach files"/);
  assert.match(attachBox, /className="feed-chip" title=\{paper\.title\}/);

  // The highlighted editor paints the textarea's glyphs transparent, which hid its
  // placeholder too: every prompt and the composer had one that never showed.
  assert.match(styles, /\.prompt-code-editor textarea::placeholder \{[^}]*-webkit-text-fill-color: var\(--soft\)/);
});

test("the toolbar search field gives way instead of squeezing the status tabs", async () => {
  const styles = await readApplicationStyles();
  // A fixed-width search field left the tabs as the row's only flexible item, so
  // the selection actions squeezed them down to "All" behind a hidden scrollbar.
  // The field is elastic between 220px and 390px and grows ahead of the tabs, and
  // the tabs take the leftover width without ever giving any back, so the row
  // neither clips them nor spreads apart on justify-content: space-between.
  assert.match(styles, /\.compact-toolbar > \.page-search\.inline-search \{[^}]*flex: 6 1 220px/);
  assert.match(styles, /\.compact-toolbar > \.page-search\.inline-search \{[^}]*max-width: 390px/);
  assert.match(styles, /\.library-toolbar \.filter-tabs \{[^}]*flex: 1 0 auto/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.compact-toolbar > \.page-search\.inline-search \{[^}]*max-width: 100%/);
});

test("no CSS rule is fully superseded by a later copy of the same selector", async () => {
  // The stylesheets accumulated selectors defined three and four times across
  // files, where the later copy silently won: a value was set in one file and
  // overridden in another, so editing the obvious one did nothing. Whenever a
  // block's every property is re-declared by a later block with the identical
  // selector, that block is dead weight and hides where the real value lives.
  const { stdout } = await execFile("python3", ["scripts/find-dead-css.py"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  const count = Number(/superseded by a later same-selector block: (\d+)/.exec(stdout)?.[1] ?? "-1");
  assert.equal(count, 0, `dead CSS blocks found (run scripts/find-dead-css.py):\n${stdout}`);
});
