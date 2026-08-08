import assert from "node:assert/strict";
import test from "node:test";

import { exportReferences } from "../../app/lib/reference-export.ts";
import type { Paper } from "../../app/lib/types.ts";

const paper: Paper = {
  id: "paper-1",
  title: "A Conference Paper",
  abstract: "",
  year: 2026,
  paperType: "conference",
  volume: null,
  issue: null,
  pages: "1-12",
  category: null,
  doi: null,
  arxivId: null,
  preprintId: null,
  semanticScholarId: null,
  url: null,
  pdfUrl: null,
  pdfViewUrl: null,
  localPath: null,
  htmlSnapshotPath: null,
  htmlUrl: null,
  summary: "",
  notes: "",
  readingStatus: "unread",
  favorite: false,
  venueId: null,
  venueName: "Example Conference",
  venueAcronym: "EC",
  addedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  authors: [{ id: "author-1", displayName: "Ada Lovelace", orcid: null, order: 0, corresponding: false }],
  collections: [],
};

test("BibTeX exports page ranges with double hyphens", () => {
  for (const pages of ["1-12", "1–12", "1—12", "1 -- 12"]) {
    const output = exportReferences([{ ...paper, pages }], "bibtex");
    assert.match(output, /  pages = \{1--12\}/);
  }
});

test("non-BibTeX exports keep the stored page formatting", () => {
  assert.match(exportReferences([paper], "ieee"), /pp\. 1-12/);
});
