import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("all workspaces reuse the shared entrance, interaction, and disclosure motion", async () => {
  const [stacks, feed, reader, visualization, controls, foundation, workspaceStyles, activityStyles] = await Promise.all([
    readFile(new URL("../../app/components/Stacks.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/components/ReaderWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/feed/visualization/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/components/ui/controls.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/styles/foundation.css", import.meta.url), "utf8"),
    readFile(new URL("../../app/styles/workspaces.css", import.meta.url), "utf8"),
    readFile(new URL("../../app/styles/data-interactions.css", import.meta.url), "utf8"),
  ]);

  assert.match(stacks, /className="stacks-shell workspace-enter app-interaction-scope"/);
  assert.match(feed, /className=\{`feed-page workspace-enter app-interaction-scope/);
  assert.equal((reader.match(/reader-page(?: reader-page-state)? workspace-enter app-interaction-scope/g) ?? []).length, 3);
  assert.match(visualization, /className="mermaid-visualization-page workspace-enter app-interaction-scope"/);
  assert.match(controls, /app-control-motion/);
  assert.equal((foundation.match(/@keyframes workspace-enter/g) ?? []).length, 1);
  assert.match(foundation, /\.workspace-enter\s*\{[^}]*animation:\s*workspace-enter var\(--motion-control\)/s);
  assert.match(foundation, /\.disclosure-chevron\s*\{[^}]*transition:\s*transform var\(--motion-fast\)/s);
  assert.match(foundation, /details\[open\] > summary \.disclosure-chevron\s*\{[^}]*rotate\(90deg\)/s);
  assert.match(foundation, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.workspace-enter\s*\{[^}]*animation:\s*none/s);
  assert.match(foundation, /\.app-interaction-scope :is\(button, a, \[role="button"\]\)/);
  assert.doesNotMatch(workspaceStyles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(feed, /className="disclosure-chevron"/);
  assert.match(workspaceStyles, /:is\(\.feed-tool-call, \.feed-tool-group\)\s*\{/);
  assert.match(workspaceStyles, /:is\(\.feed-tool-call, \.feed-tool-group\) > summary\s*\{/);
  assert.doesNotMatch(workspaceStyles, /feed-tool-group-chevron/);
  assert.doesNotMatch(activityStyles, /background-task-diagnostics\[open\] summary svg/);
});
