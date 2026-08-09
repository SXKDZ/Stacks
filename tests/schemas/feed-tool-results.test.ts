import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createTempLibrary } from "../support/harness";

createTempLibrary("stacks-feed-tool-results");

test("feed tool results are stored without a hidden character cap", async () => {
  const { toolResultText } = await import("../../app/lib/feed-agent");
  const first = "a".repeat(4_500);
  const second = "b".repeat(4_500);

  assert.equal(toolResultText(first), first);
  assert.equal(toolResultText([{ type: "text", text: first }, { type: "text", text: second }]), `${first}\n${second}`);
});

test("tool requests and results have no display-time persistence slices", async () => {
  const [source, themeStyles, workspaceStyles] = await Promise.all([
    readFile(new URL("../../app/lib/feed-agent.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/styles/themes.css", import.meta.url), "utf8"),
    readFile(new URL("../../app/styles/workspaces.css", import.meta.url), "utf8"),
  ]);
  const toolBody = workspaceStyles.match(/\.markdown-content\.feed-tool-md pre\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.doesNotMatch(source, /slice\(0,\s*(?:800|4000)\)/);
  assert.match(themeStyles, /\.markdown-content pre code[^}]*border-radius:\s*0/s);
  assert.match(toolBody, /border-radius:\s*0/);
  assert.match(toolBody, /max-height:\s*min\(30vh,\s*360px\)/);
  assert.match(toolBody, /overflow:\s*auto/);
  assert.doesNotMatch(toolBody, /max-height:\s*300px|overflow-y/);
});
