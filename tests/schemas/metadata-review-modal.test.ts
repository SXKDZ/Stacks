import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("metadata review is an independent content-sized modal instead of inheriting the edit frame", async () => {
  const [application, styles] = await Promise.all([
    readFile(new URL("../../app/components/Stacks.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/styles/data-interactions.css", import.meta.url), "utf8"),
  ]);
  const layer = styles.match(/\.metadata-review-layer\s*\{([^}]*)\}/)?.[1] ?? "";
  const dialog = styles.match(/\.metadata-review-dialog\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(application, /pendingMetadataReview[^?]*\? createPortal\(/);
  assert.match(layer, /position:\s*fixed/);
  assert.match(dialog, /max-height:\s*min\(720px/);
  assert.match(dialog, /max-width:\s*780px/);
  assert.doesNotMatch(dialog, /height:\s*100%/);
});
