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

test("the feed theme toggle is centered on the header it floats over", async () => {
  const workspace = await readFile(new URL("../../app/components/FeedWorkspace.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../app/styles/workspaces.css", import.meta.url), "utf8");
  const toggle = styles.match(/\.feed-theme-toggle\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(toggle, /justify-content:\s*center/);
  assert.match(toggle, /align-items:\s*center/);
  assert.match(toggle, /right:\s*0/);
  assert.match(toggle, /width:\s*76px/);

  // The bar is as tall as its statistics wrap, so its height is measured and published
  // rather than assumed: two fixed guesses (62px, and 86px for a thread) left the
  // toggle sitting above the middle of every bar that wrapped past them.
  assert.match(toggle, /height:\s*var\(--feed-head-height, 62px\)/);
  assert.doesNotMatch(styles, /\.feed-page\.has-thread\s*>\s*\.feed-theme-toggle/);
  assert.match(workspace, /page\.style\.setProperty\("--feed-head-height"/);
  assert.match(workspace, /new ResizeObserver\(publish\)/);
  // The bar the toggle covers is the thread's; the list's is what a collapsed phone
  // layout leaves, and a hidden pane measures zero.
  assert.match(workspace, /page\.querySelector<HTMLElement>\("\.feed-detail-head"\), page\.querySelector<HTMLElement>\("\.feed-list-head"\)/);
});

test("a rewound turn's attachments come back as composer chips and are re-sent by reference", async () => {
  const [attachBox, workspace] = await Promise.all([
    readFile(new URL("../../app/components/feed/AttachBox.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
  ]);

  // The chips are removable and count as attachments, so a rewound turn whose only
  // content was a file can still be sent.
  assert.match(attachBox, /const \[carried, setCarried\] = useState<SnippetAttachment\[\]>\(initialAttachments\)/);
  assert.match(attachBox, /hasAttachments =[^;]*carried\.length > 0/);
  assert.match(attachBox, /carried\.map\(\(attachment, index\) => \(/);
  assert.match(attachBox, /setCarried\(\(current\) => current\.filter\(\(_, i\) => i !== index\)\)/);
  assert.match(attachBox, /onSubmit\(\{[^}]*carried,/);
  assert.match(attachBox, /setCarried\(\[\]\)/);

  // The rewind's reply and its attachments are restored together, and the reply goes
  // as multipart whenever anything is attached, carried included.
  assert.match(workspace, /setRestoredAttachments\(payload\?\.attachments \?\? \[\]\)/);
  assert.match(workspace, /initialAttachments=\{restoredAttachments\}/);
  assert.match(workspace, /payload\.files\.length \|\| payload\.paperIds\.length \|\| payload\.carried\.length/);
  assert.match(workspace, /form\.set\("carried", JSON\.stringify\(payload\.carried\)\)/);
});
