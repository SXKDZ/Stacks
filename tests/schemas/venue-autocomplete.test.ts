import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("venue autocomplete follows the field that opened it", async () => {
  const application = await readFile(new URL("../../app/components/Stacks.tsx", import.meta.url), "utf8");

  assert.match(application, /const acronymFieldRef = useRef<HTMLLabelElement>\(null\)/);
  assert.match(application, /activeField === "acronym" \? acronymFieldRef : nameFieldRef/);
  assert.match(application, /<AnchoredOptions anchorRef=\{activeFieldRef\}/);
  assert.doesNotMatch(application, /<AnchoredOptions anchorRef=\{nameFieldRef\}[^>]*venue-autocomplete-options/);
});
