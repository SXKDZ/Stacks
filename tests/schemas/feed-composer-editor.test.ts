import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("new-feed and reply composers share a resizable highlighted Markdown editor", async () => {
  const [attachBox, editor, editorStyles, workspaceStyles] = await Promise.all([
    readFile(new URL("../../app/components/feed/AttachBox.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/components/ui/MarkdownCodeEditor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/styles/design-system.css", import.meta.url), "utf8"),
    readFile(new URL("../../app/styles/workspaces.css", import.meta.url), "utf8"),
  ]);

  assert.match(attachBox, /<MarkdownCodeEditor/);
  assert.match(attachBox, /className="feed-composer-editor"/);
  assert.doesNotMatch(editor, /resize-handle|resize:\s*vertical/);
  assert.match(attachBox, /className="feed-dock-input is-panel-resizable"/);
  assert.match(attachBox, /role="separator"/);
  assert.match(attachBox, /onPointerMove=\{movePanelResize\}/);
  assert.match(attachBox, /onKeyDown=\{resizePanelWithKeyboard\}/);
  assert.match(workspaceStyles, /\.feed-panel-resize-handle[^}]*cursor:\s*ns-resize/s);
  assert.match(workspaceStyles, /\.feed-panel-resize-handle\s*\{[^}]*opacity:\s*0/s);
  assert.match(workspaceStyles, /\.feed-panel-resize-handle:hover\s*\{[^}]*opacity:\s*1/s);
  assert.match(workspaceStyles, /\.feed-panel-resize-handle:focus-visible\s*\{[^}]*opacity:\s*1/s);
  assert.match(workspaceStyles, /\.feed-dock \.feed-composer-editor textarea[^}]*padding:\s*5px 6px/s);
  assert.match(workspaceStyles, /\.prompt-code-editor \.hljs-emphasis[^}]*color:\s*var\(--brand-blue-strong\)[^}]*font-style:\s*italic/s);
  assert.match(workspaceStyles, /\.prompt-code-editor \.hljs-strong[^}]*color:\s*var\(--brand-blue-strong\)[^}]*font-weight:\s*700/s);
  assert.match(editorStyles, /\.prompt-code-editor textarea[^}]*resize:\s*none/s);
});

test("the full working directory has its own row below the feed statistics", async () => {
  const workspace = await readFile(new URL("../../app/components/FeedWorkspace.tsx", import.meta.url), "utf8");
  const metaStart = workspace.indexOf('<div className="feed-detail-meta">');
  const metaEnd = workspace.indexOf("</div>", metaStart);
  const pathIndex = workspace.indexOf('className="feed-working-directory-link"');

  assert.ok(metaStart >= 0 && metaEnd > metaStart);
  assert.ok(pathIndex > metaEnd, "the path row should follow the closed statistics row");
  assert.match(workspace.slice(pathIndex, pathIndex + 900), /<code>\{workingDirectory/);
});

test("the feed theme toggle is centered in the header's reserved control slot", async () => {
  const workspace = await readFile(new URL("../../app/components/FeedWorkspace.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../app/styles/workspaces.css", import.meta.url), "utf8");
  const toggle = styles.match(/\.feed-theme-toggle\s*\{([^}]*)\}/)?.[1] ?? "";
  const threadToggle = styles.match(/\.feed-page\.has-thread\s*>\s*\.feed-theme-toggle\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(toggle, /justify-content:\s*center/);
  assert.match(toggle, /align-items:\s*center/);
  assert.match(toggle, /right:\s*0/);
  assert.match(toggle, /width:\s*76px/);
  assert.match(toggle, /height:\s*62px/);
  assert.match(workspace, /showDetail \? "has-thread"/);
  assert.match(threadToggle, /height:\s*86px/);
});
