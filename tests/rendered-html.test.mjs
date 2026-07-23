import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readApplicationStyles } from "./read-application-styles.mjs";

test("ships the Stacks application shell and product metadata", async () => {
  const [page, layout, application, reader, settings, markdown, controls, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/components/Stacks.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/ReaderWorkspace.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/SettingsView.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/MarkdownContent.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/ui/controls.tsx", import.meta.url),
      "utf8",
    ),
    readApplicationStyles(),
  ]);

  assert.match(page, /<Stacks \/>/);
  assert.match(layout, /title: "Stacks"/);
  assert.match(layout, /@fontsource-variable\/geist/);
  assert.match(layout, /@fontsource-variable\/jetbrains-mono/);
  assert.match(layout, /katex\/dist\/katex\.min\.css/);
  assert.doesNotMatch(layout, /manrope|newsreader/i);
  assert.doesNotMatch(application, /Your research, in motion/);
  assert.doesNotMatch(application, /Research OS/);
  assert.match(application, /paper\.authors\.map\(\(author\) => author\.displayName\)\.join\(", "\)/);
  assert.match(application, /\$\{hiddenCount\} more \$\{hiddenCount === 1/);
  assert.match(application, /Show less/);
  assert.match(application, /aria-expanded=\{expanded\}/);
  assert.match(application, /AuthorsView/);
  assert.match(application, /VenuesView/);
  assert.match(application, /DiscoverView/);
  assert.match(application, /Semantic Scholar/);
  assert.match(application, /Google Scholar/);
  assert.match(application, /arXiv/);
  assert.match(application, /DBLP/);
  assert.match(application, /Crossref/);
  assert.match(application, /OpenReview/);
  assert.match(application, /openFeedWorkspace/);
  assert.match(application, /PaperEditModal/);
  assert.doesNotMatch(application, /Read inside PA/);
  assert.match(application, /<ActionButton[\s\S]*?Read[\s\S]*?<\/ActionButton>/);
  assert.match(application, /<ActionLink[\s\S]*?Source[\s\S]*?<\/ActionLink>/);
  assert.match(controls, /class-variance-authority/);
  assert.match(controls, /tailwind-merge/);
  assert.match(application, /MarkdownContent/);
  assert.match(application, /abstract-copy/);
  assert.match(application, /summary-copy/);
  assert.match(reader, /reader-summary-scroll/);
  // Notes use the shared markdown editor (same component as the paper editor
  // and prompt settings) rather than a bespoke textarea.
  assert.match(reader, /MarkdownCodeEditor/);
  assert.match(reader, /ariaLabel="My notes"/);
  assert.match(reader, /setNoteState\("saved"\)/);
  assert.match(application, /const \[filterBuilderOpen, setFilterBuilderOpen\] = useState\(false\)/);
  assert.match(application, /filterBuilderOpen \? "is-open"/);
  assert.match(application, /aria-pressed=\{filterBuilderOpen\}/);
  assert.doesNotMatch(application, /onSummarize/);
  assert.match(application, /field-label-action/);
  assert.ok(application.indexOf("Research notes") < application.indexOf("Publication details"));
  assert.match(markdown, /react-markdown/);
  assert.match(markdown, /remark-gfm/);
  assert.match(markdown, /remark-math/);
  assert.match(markdown, /rehype-katex/);
  assert.match(markdown, /normalizeLatexDelimiters/);
  assert.match(markdown, /skipHtml/);
  assert.match(settings, /OneDrive sync/);
  assert.match(settings, /BEDROCK_MODEL_ID|modelId/);
  assert.doesNotMatch(application, /Cited by|<small>Citations<\/small>|h-index/i);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /scrollbar-gutter: stable/);
  assert.match(styles, /\.filter-builder-toggle\.is-open/);
  assert.match(styles, /AIScientist-aligned application skin/);
  assert.match(styles, /\.markdown-content \.katex-display/);
  assert.match(styles, /@media \(max-width: 560px\)/);
  assert.doesNotMatch(styles, /\.ui-action(?:--|\b)|\.ui-status(?:--|\b)/);
  assert.doesNotMatch(page + layout + application, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("every referenced CSS custom property is defined (no ghost tokens)", async () => {
  const styles = await readApplicationStyles();
  // Tokens defined anywhere (:root, [data-theme], etc.).
  const defined = new Set(
    Array.from(styles.matchAll(/(--[a-z0-9-]+)\s*:/g), (match) => match[1]),
  );
  // Tokens injected via inline style in components rather than CSS.
  const injectedAtRuntime = new Set(["--progress"]);
  // A var() reference is safe if it is defined, injected, or has a fallback
  // (the second argument to var()).
  const missing = new Set();
  for (const match of styles.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/g)) {
    const token = match[1];
    const hasFallback = Boolean(match[2]);
    if (defined.has(token) || injectedAtRuntime.has(token) || hasFallback) {
      continue;
    }
    missing.add(token);
  }
  assert.deepEqual(
    [...missing],
    [],
    `Undefined CSS custom properties referenced without a fallback: ${[...missing].join(", ")}`,
  );
});

test("button archetypes route through shared primitives, not hand-written CSS", async () => {
  const styles = await readApplicationStyles();
  const [controls, settings] = await Promise.all([
    readFile(new URL("../app/components/ui/controls.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SettingsView.tsx", import.meta.url), "utf8"),
  ]);

  // The expanded primitive set must exist so components have a home for every
  // button archetype instead of re-declaring styles in CSS.
  for (const primitive of ["ActionButton", "TabButton", "Chip", "TextButton", "SelectCard", "Scrim", "PaginationButton"]) {
    assert.match(controls, new RegExp(`export function ${primitive}\\b`), `missing primitive ${primitive}`);
  }

  // Tailwind v4 treats an untyped arbitrary var() text value as a color. Font-size tokens
  // must use the explicit length hint or controls silently fall back to 14px.
  assert.doesNotMatch(controls, /text-\[var\(--type-/);
  assert.match(controls, /text-\[length:var\(--type-control\)\]/);
  assert.match(controls, /light:\s*\[[\s\S]*?border-\[rgba\(16,19,26,0\.14\)\]/);
  assert.doesNotMatch(controls, /light:\s*\[[\s\S]{0,80}?border-0/);

  // CVA emits both base and selected-state utilities. Every variant result
  // must pass through twMerge so active borders/backgrounds win consistently.
  assert.match(controls, /return cx\(actionVariants\(/);
  assert.match(controls, /className=\{cx\(statusVariants\(/);
  assert.match(controls, /className=\{cx\(tabVariants\(/);

  // The browser reset must stay in Tailwind's base layer. An unlayered
  // `button { border: 0 }` overrides the shared utility-layer borders.
  assert.match(styles, /@layer base\s*\{[\s\S]*?button\s*\{[\s\S]*?border:\s*0/);
  // A dark canvas token and the opaque surface ladder are defined (exact hex may
  // change with design-token refreshes; assert the tokens exist, not their value).
  assert.match(styles, /--canvas:\s*#0[0-9a-f]{5}/i);
  assert.match(styles, /--surface-1:/);
  assert.match(styles, /--surface-2:/);
  assert.match(styles, /--brand-cta:\s*#168dec/);
  assert.doesNotMatch(styles, /\.nav-item\.is-active\s*\{[\s\S]{0,180}?rgba\(124,\s*156,\s*255/);
  assert.match(styles, /\.nav-item\.is-active\s*\{[\s\S]{0,180}?var\(--brand-blue\) 10%/);

  // Storage & Doctor uses deliberately sectioned settings cards. The heading
  // shares the consolidated settings-card header spec; losing the group makes
  // the headings, path summary, form, and metrics collapse into a single
  // unpadded white surface.
  assert.match(styles, /\.settings-card-title,\s*\.storage-location-heading,\s*\.storage-doctor-heading\s*\{[\s\S]*?padding:\s*13px 15px/);
  assert.match(styles, /\.storage-root-summary\s*\{[\s\S]*?background:\s*transparent[\s\S]*?border:\s*0/);
  assert.match(styles, /\.storage-move-field\s*\{[\s\S]*?padding:\s*12px 16px 16px/);
  assert.match(settings, /body:\s*JSON\.stringify\(\{ target: "storage" \}\)/);
  assert.match(settings, />Browse<\/ActionButton>/);
  // The sync status icon uses the shared 29px settings-card icon treatment;
  // it must not restore the old green-glyph-on-blue-background exception.
  assert.match(settings, /className="sync-status-icon"><FolderSync size=\{16\}/);
  assert.doesNotMatch(styles, /\.sync-status-icon\.is-success/);
  assert.doesNotMatch(settings, /variant="ghost"[\s\S]{0,120}>Restore (?:discussion|summary|extraction) default/);
  assert.match(settings, /variant="secondary" size="small" className="mt-0\.5 justify-self-start"[\s\S]{0,160}>Restore summary default/);

  // These descendant-button rules were migrated to primitives; if they come
  // back they will override the primitive's classes (CSS here is unlayered).
  const forbiddenSelectors = [
    /\.filter-tabs button/, /\.source-row button/, /\.provider-switch button/,
    /\.modal-tabs button/, /\.status-selector button/, /\.settings-nav > button/,
    /\.export-format-tabs button/, /\.identifier-source-grid > button/,
    /\.theme-choice-grid > button/, /\.discovery-capabilities > button/,
    /\.chat-prompts button/, /\.prompt-suggestions button/,
    /\.pagination-pages > button/, /\.transfer-pagination nav > button/,
    /\.transfer-actions button/, /\.source-url-control > button/,
    /\.theme-toggle\b/, /\.new-chat-button\b/, /\.reader-chat-button\b/,
    /\.text-button\b/, /\.collection-edit-tag\b/, /\.modal-scrim\b/,
  ];
  const regressed = forbiddenSelectors.filter((pattern) => pattern.test(styles)).map((pattern) => pattern.source);
  assert.deepEqual(regressed, [], `Migrated button CSS reappeared: ${regressed.join(", ")}`);
});
