import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("URL import uses the same horizontal modal gutter as the other Add to Stacks tabs", async () => {
  const styles = await readFile(new URL("../../app/styles/reading-assistant.css", import.meta.url), "utf8");
  const importForm = styles.match(/\.import-form\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(importForm, /padding-inline:\s*20px/);
  assert.doesNotMatch(importForm, /padding:\s*42px\s+44px/);
});
