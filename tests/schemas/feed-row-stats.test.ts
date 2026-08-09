import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("feed rows use compact, explained age and token labels", async () => {
  const source = await readFile(new URL("../../app/components/FeedWorkspace.tsx", import.meta.url), "utf8");

  assert.match(source, /return `\$\{mins\} min`/);
  assert.match(source, /aria-label=\{`Updated \$\{relativeTime\(snippet\.updatedAt\)\}`\}/);
  assert.match(source, /title=\{`Updated \$\{fullTime\(snippet\.updatedAt\)\}`\}/);
  assert.match(source, /\{compactTokens\(tokens\)\} tokens/);
  assert.match(source, /aria-label=\{`\$\{tokens\.toLocaleString\(\)\} tokens used`\}/);
  assert.doesNotMatch(source, /\{compactTokens\(tokens\)\} tok</);
  assert.match(source, /1_000_000/);
});
