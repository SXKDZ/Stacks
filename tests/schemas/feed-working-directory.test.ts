import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createTempLibrary } from "../support/harness";

const libraryRoot = createTempLibrary("stacks-feed-working-directory");

test("each feed detail can safely open its managed working directory", async () => {
  const [workspace, styles, route, localFiles] = await Promise.all([
    readFile(new URL("../../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/styles/workspaces.css", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/feed/snippets/[id]/working-directory/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/lib/local-files.ts", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /Open feed working directory/);
  assert.match(workspace, /\/working-directory/);
  assert.match(workspace, /className="feed-working-directory-link"/);
  assert.match(workspace, /feed-detail-head feed-detail-thread-head/);
  assert.match(workspace, /<code>\{workingDirectory/);
  assert.match(styles, /\.feed-detail-thread-head[^}]*min-height:\s*86px/s);
  assert.match(route, /where\(eq\(feedSnippets\.id, id\)\)/);
  assert.match(route, /export async function GET/);
  assert.match(route, /feedWorkingDir\(id\)/);
  assert.match(route, /mkdirSync\(workingDirectory, \{ recursive: true \}\)/);
  assert.match(route, /await revealDirectory\(workingDirectory\)/);
  assert.match(localFiles, /export async function revealDirectory/);
});

test("feed working directories stay inside the managed library", async () => {
  const { feedWorkingDir } = await import("../../app/lib/feed-agent");

  assert.equal(feedWorkingDir("feed-123"), join(libraryRoot, "feed", "feed-123"));
  for (const unsafeId of ["..", "../outside", "feed/child", "feed\\child", "feed id"]) {
    assert.throws(() => feedWorkingDir(unsafeId), /Invalid feed id/);
  }
});
