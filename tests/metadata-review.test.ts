import assert from "node:assert/strict";
import test from "node:test";

import {
  comparableMetadataValue,
  isExtractedMetadataFieldApplicable,
} from "../app/lib/metadata-review.ts";
import { paperTypeOptions } from "../app/lib/paper-fields.ts";

test("metadata comparison is whitespace-normalized and locale-independent", () => {
  assert.equal(comparableMetadataValue("  MIXED\n  Case  "), "mixed case");
  assert.equal(comparableMetadataValue("I"), "i");
  assert.equal(comparableMetadataValue("İ"), "i\u0307");
});

test("metadata review always permits fields shared by every paper type", () => {
  for (const { value: paperType } of paperTypeOptions) {
    for (const field of ["title", "authors", "year", "paperType", "abstract"] as const) {
      assert.equal(
        isExtractedMetadataFieldApplicable(field, paperType),
        true,
        `${field} should be applicable to ${paperType}`,
      );
    }
  }
});

test("metadata review disables fields the selected paper type cannot store", () => {
  assert.equal(isExtractedMetadataFieldApplicable("venueAcronym", "preprint"), false);
  assert.equal(isExtractedMetadataFieldApplicable("preprintId", "preprint"), true);
  assert.equal(isExtractedMetadataFieldApplicable("category", "journal"), false);
  assert.equal(isExtractedMetadataFieldApplicable("venueAcronym", "journal"), true);
  assert.equal(isExtractedMetadataFieldApplicable("doi", "website"), false);
  assert.equal(isExtractedMetadataFieldApplicable("url", "website"), true);
});
