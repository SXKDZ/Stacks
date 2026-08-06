/**
 * Which fields the add/edit paper form shows per paper type.
 *
 * The form's render and its submit handler both read this, and they must agree: a
 * field the submit reads but the form never rendered arrives empty and overwrites
 * whatever was stored. That is how a switched paper type used to strand a file.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { editablePaperType, metadataVisibility, paperTypeOptions } from "../../app/lib/paper-fields.ts";

test("the local file fields are not part of the type rule at all", () => {
  // The regression this pins down: snapshotting a website and then switching the
  // type to a paper hid the HTML field, so a file that was still on disk and still
  // listed in the detail panel had no field left to inspect, replace, or clear it.
  // Keeping them out of this rule is what makes them unconditional at the call site.
  for (const option of paperTypeOptions) {
    const visible = metadataVisibility(option.value) as Record<string, boolean>;
    assert.equal(visible.pdf, undefined, `${option.value} must not gate the PDF field`);
    assert.equal(visible.html, undefined, `${option.value} must not gate the HTML field`);
  }
});

test("a website hides the fields a web page cannot have", () => {
  const visible = metadataVisibility("website");
  assert.equal(visible.volumeIssue, false);
  assert.equal(visible.pages, false);
  assert.equal(visible.doi, false);
  assert.equal(visible.preprint, false);
  // But it does have a publisher name and a URL.
  assert.equal(visible.venueName, true);
  assert.equal(visible.url, true);
});

test("a journal article shows volume, issue, pages, and a DOI", () => {
  const visible = metadataVisibility("journal");
  assert.equal(visible.volumeIssue, true);
  assert.equal(visible.pages, true);
  assert.equal(visible.doi, true);
  assert.equal(visible.venueAcronym, true);
  // A journal article is not a preprint, so it has no category field.
  assert.equal(visible.preprint, false);
});

test("a preprint shows its identifier and source URL but no volume", () => {
  const visible = metadataVisibility("preprint");
  assert.equal(visible.preprint, true);
  assert.equal(visible.url, true);
  assert.equal(visible.venueAcronym, false, "preprints use the repository name without a separate acronym");
  assert.equal(visible.volumeIssue, false);
  assert.equal(visible.pages, false);
});

test("conference and workshop papers are treated alike", () => {
  assert.deepEqual(metadataVisibility("conference"), metadataVisibility("workshop"));
});

test("\"other\" shows every bibliographic field, since the type says nothing", () => {
  const visible = metadataVisibility("other");
  for (const [field, shown] of Object.entries(visible)) {
    assert.equal(shown, true, `${field} should be available for an unclassified record`);
  }
});

test("an unknown stored type falls back to \"other\" rather than hiding everything", () => {
  // Types come out of the database as plain strings, so a value written by an older
  // version (or by hand) must not collapse the form.
  assert.equal(editablePaperType("thesis"), "other");
  assert.equal(editablePaperType(""), "other");
  assert.equal(editablePaperType("Conference"), "other", "matching is exact, not case-insensitive");
  // Known values pass through unchanged.
  for (const option of paperTypeOptions) {
    assert.equal(editablePaperType(option.value), option.value);
  }
});
