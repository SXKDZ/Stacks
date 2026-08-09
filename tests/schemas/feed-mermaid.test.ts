import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("AI feed rich content opens in focused viewers with safe Mermaid rendering", async () => {
  const [markdown, diagram, richContent, storage, visualization, sharedTable, feed, styles, packageJson] = await Promise.all([
    readFile(new URL("../../app/components/MarkdownContent.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/components/MermaidDiagram.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/components/FeedRichContent.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/lib/feed-visualization.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/feed/visualization/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/components/ui/ResizableTable.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/styles/workspaces.css", import.meta.url), "utf8"),
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(packageJson, /"mermaid":/);
  assert.match(markdown, /language-mermaid/);
  assert.match(markdown, /enableFeedRichContent/);
  assert.match(markdown, /FeedCodeBlock/);
  assert.match(markdown, /FeedImage/);
  assert.match(markdown, /FeedTable/);
  assert.match(feed, /className="feed-bubble" enableFeedRichContent feedId=\{snippet\.id\}/);
  assert.match(feed, /renderToolContent\(toolInput, snippet\.id, feedName\)/);
  assert.match(feed, /document\.title = `\$\{title\} · Stacks`/);

  assert.match(diagram, /import\("mermaid"\)/);
  assert.match(diagram, /securityLevel:\s*"strict"/);
  assert.match(diagram, /suppressErrorRendering:\s*true/);
  assert.match(diagram, /Could not render this Mermaid diagram/);
  assert.match(diagram, /aria-label="Open in new window"/);
  assert.doesNotMatch(diagram, />\s*Open in new window/);
  assert.match(storage, /`\$\{kind\}-\$\{feedId\}-\$\{contentFingerprint\(content\)\}`/);
  assert.match(storage, /feedName:/);

  assert.match(richContent, /aria-label=\{copied \? "Code copied" : "Copy code"\}/);
  assert.match(richContent, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(richContent, /kind: "image"/);
  assert.match(richContent, /kind: "table"/);
  assert.match(richContent, /querySelectorAll\("thead th"\)/);

  assert.match(visualization, /securityLevel:\s*"strict"/);
  assert.match(visualization, /suppressErrorRendering:\s*true/);
  assert.match(visualization, /aria-label="Zoom out"/);
  assert.match(visualization, /aria-label="Zoom in"/);
  assert.match(visualization, /aria-pressed=\{interactionMode === "pan"\}/);
  assert.match(visualization, /aria-pressed=\{interactionMode === "select"\}/);
  assert.match(visualization, /onPointerDown=\{beginDrag\}/);
  assert.match(visualization, /setPointerCapture/);
  assert.match(visualization, /navigator\.clipboard\.writeText\(visualization\.source\)/);
  assert.match(visualization, /placeholder="Filter rows…"/);
  assert.match(visualization, /localeCompare/);
  assert.match(visualization, /className="feed-table-row-resize"/);
  assert.match(visualization, /function RowResizeHandle/);
  assert.doesNotMatch(visualization, /GripHorizontal/);
  assert.match(visualization, /target: "header" \| number/);
  assert.match(visualization, /beginRowResize\(event, "header"\)/);
  assert.match(visualization, /closest\("tr"\)\?\.getBoundingClientRect\(\)\.height/);
  assert.match(visualization, /className="feed-table-column-resize feed-table-column-resize-body"/);
  assert.match(visualization, /highlightedColumn === cellIndex/);
  assert.match(visualization, /highlightedRow === originalIndex \? "is-row-resize-highlight"/);
  assert.match(visualization, /setPointerCapture/);
  assert.match(visualization, /resizeRowWithKeyboard/);
  assert.match(visualization, /VisualizationTableHeader/);
  assert.match(visualization, /useResizableColumns/);
  assert.match(visualization, /className="feed-visualization-table"/);
  assert.match(sharedTable, /className="column-resize-handle"/);
  assert.match(sharedTable, /className=\{`table-sort-button/);
  assert.match(sharedTable, /aria-sort=/);
  assert.match(sharedTable, /table\.querySelectorAll\("th\.is-resizable"\)/);
  assert.match(visualization, /ariaLabel="Syntax highlighting language"/);
  assert.match(visualization, /className="feed-code-language-select"/);
  assert.match(visualization, /fenceCode\(visualization\.source, language\)/);
  assert.match(visualization, /const toggleFit = useCallback/);
  assert.match(visualization, /Math\.abs\(scale - 1\) < 0\.01/);
  assert.match(visualization, /lastPanTapRef/);
  assert.match(visualization, /now - previous\.time <= 400/);
  assert.match(visualization, /toggleFit\(\)/);
  assert.match(visualization, /new MutationObserver\(applyTitle\)/);
  assert.match(visualization, /return `\$\{visualizationKindLabel\(visualization\)\} · \$\{visualization\.feedName\}`/);
  assert.match(visualization, /onWheel=\{handleWheel\}/);
  assert.match(visualization, /event\.key\.toLocaleLowerCase\(\) === "f"/);

  assert.match(styles, /\.feed-rich-actions\s*\{[^}]*opacity:\s*0[^}]*position:\s*absolute/s);
  assert.match(styles, /\.feed-rich-action\s*\{[^}]*border-radius:\s*var\(--radius-control\)/s);
  assert.match(styles, /\.feed-rich-action:focus-visible\s*\{[^}]*outline:\s*2px/s);
  assert.match(styles, /\.mermaid-visualization-viewport\s*\{[^}]*cursor:\s*grab/s);
  assert.match(styles, /\.mermaid-visualization-viewport\.is-dragging\s*\{[^}]*cursor:\s*grabbing/s);
  assert.match(styles, /\.mermaid-visualization-viewport\.is-selection-mode\s*\{[^}]*cursor:\s*text[^}]*user-select:\s*text/s);
  assert.match(styles, /\.mermaid-visualization-viewport\.is-selection-mode \.mermaid-visualization-svg \*/);
  assert.match(styles, /\.feed-table-row-resize\s*\{[^}]*cursor:\s*row-resize/s);
  assert.match(styles, /\.feed-visualization-table th\s*\{[^}]*position:\s*sticky/s);
  assert.match(styles, /\.feed-table-cell-content\s*\{[^}]*block-size:\s*auto[^}]*overflow:\s*visible/s);
  assert.match(styles, /\.is-column-resize-highlight::after\s*\{[^}]*block-size:\s*calc\(100% \+ 2px\)[^}]*inset-block-start:\s*-1px[^}]*inset-inline-end:\s*-1px/s);
  assert.match(styles, /tr\.is-row-resize-highlight::after\s*\{[^}]*left:\s*-1px[^}]*right:\s*-1px/s);
  assert.match(styles, /\.mermaid-visualization-svg,[^}]*\.feed-image-visualization\s*\{[^}]*transition-property:\s*width, height/s);
  assert.match(styles, /\.feed-table-visualization-scroll\s*\{[^}]*overflow-x:\s*clip/s);
  assert.match(visualization, /const availableWidth = Math\.max\(1, viewport\.clientWidth - viewportInsets\.horizontal - canvasInsets\.horizontal\)/);
  assert.match(styles, /\.feed-table-row:last-child \.feed-table-row-resize/);
  assert.match(styles, /\.mermaid-visualization-viewport\s*\{[^}]*min-width:\s*0[^}]*width:\s*100%/s);
  assert.match(styles, /\.feed-table-visualization-scroll\s*\{[^}]*min-width:\s*0[^}]*width:\s*100%/s);
});
