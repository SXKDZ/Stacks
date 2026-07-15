import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ships the Paper Assistant application shell and product metadata", async () => {
  const [page, layout, application, settings, markdown, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/components/PaperAssistant.tsx", import.meta.url),
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
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<PaperAssistant \/>/);
  assert.match(layout, /title: "Paper Assistant"/);
  assert.match(layout, /@fontsource-variable\/inter/);
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
  assert.match(application, /ChatDrawer/);
  assert.match(application, /PaperEditModal/);
  assert.doesNotMatch(application, /Read inside PA/);
  assert.match(application, /> Read<\/button>/);
  assert.match(application, /> Source<\/a>/);
  assert.match(application, /MarkdownContent/);
  assert.match(application, /abstract-copy/);
  assert.match(application, /summary-copy/);
  assert.match(application, /reader-summary-scroll/);
  assert.match(application, /reader-notes-editor/);
  assert.match(application, /aria-label="My notes"/);
  assert.match(application, /"Notes saved\."/);
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
  assert.doesNotMatch(page + layout + application, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});
