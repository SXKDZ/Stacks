/**
 * Duplicate names in the two managed directories.
 *
 * The library's own assets numbered from -2 while the feed's attachment staging
 * numbered from -1, so the same collision produced a different name depending on
 * which code path stored the file. One helper now owns the rule.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { nextFreeName } from "../../app/lib/local-files.ts";

test("duplicates number from the second copy, and skip names already taken", () => {
  const dir = mkdtempSync(join(tmpdir(), "stacks-asset-naming-"));
  try {
    assert.equal(nextFreeName(dir, "paper", ".pdf"), "paper.pdf");

    writeFileSync(join(dir, "paper.pdf"), "one");
    assert.equal(nextFreeName(dir, "paper", ".pdf"), "paper-2.pdf");

    writeFileSync(join(dir, "paper-2.pdf"), "two");
    assert.equal(nextFreeName(dir, "paper", ".pdf"), "paper-3.pdf");

    // A name that is already taken out of order is skipped, not overwritten.
    writeFileSync(join(dir, "paper-3.pdf"), "three");
    writeFileSync(join(dir, "paper-4.pdf"), "four");
    assert.equal(nextFreeName(dir, "paper", ".pdf"), "paper-5.pdf");

    // An extension-less attachment keeps the same rule.
    writeFileSync(join(dir, "notes"), "n");
    assert.equal(nextFreeName(dir, "notes", ""), "notes-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
