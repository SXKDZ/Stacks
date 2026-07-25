/**
 * BibTeX and RIS import.
 *
 * These are files people have curated for years, so the failure that matters is
 * silent loss: an entry that vanishes, or a field that arrives subtly wrong and
 * is then stored as a permanent record. Every case here was verified against the
 * previous parser.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseBibliography } from "../../app/lib/bibliography.ts";

const bib = (source: string) => parseBibliography(source, "bibtex");
const ris = (source: string) => parseBibliography(source, "ris");

test("imports a multi-entry BibTeX file, mapping each type", () => {
  const papers = bib(`@article{a, title = {Journal One}, journal = {Nature}, year = {2024}}
@inproceedings{b, title = {Conference Two}, booktitle = {NeurIPS}, year = {2025}}
@misc{c, title = {Preprint Three}, year = {2026}}`);
  assert.deepEqual(papers.map((paper) => paper.title), ["Journal One", "Conference Two", "Preprint Three"]);
  assert.equal(papers[0].paperType, "journal");
  assert.equal(papers[1].paperType, "conference");
  assert.deepEqual(papers.map((paper) => paper.year), [2024, 2025, 2026]);
});

test("an unbalanced entry does not swallow the entries after it", () => {
  // The brace scanner consumed the rest of the file, so every well-formed entry
  // after a single typo disappeared with no error.
  const papers = bib(`@article{a, title = {Good One}}
@article{b, title = {Broken {unclosed}
@article{c, title = {Should Survive}}`);
  const titles = papers.map((paper) => paper.title);
  assert.ok(titles.includes("Good One"), "the entry before the damage survives");
  assert.ok(titles.includes("Should Survive"), "and so does the entry after it");
});

test("a commented-out entry is not imported", () => {
  // `%` comments to end of line. Users comment entries out precisely so they are
  // not imported, but the scanner only looked for `@`.
  const papers = bib(`% @article{old, title = {Commented Out}}
@article{real, title = {Real Paper}}`);
  assert.deepEqual(papers.map((paper) => paper.title), ["Real Paper"]);
});

test("an escaped percent is a literal character, not a comment", () => {
  const papers = bib("@article{a, title = {Growth of 50\\% Yearly}}");
  assert.equal(papers[0].title, "Growth of 50% Yearly");
});

test("a brace-protected corporate author stays one author", () => {
  // `{{Barnes and Noble Research}}` is the standard way to say "one author, do not
  // parse"; splitting it produced two permanent author records.
  const papers = bib("@article{a, title = {T}, author = {{Barnes and Noble Research}}}");
  assert.deepEqual(papers[0].authors, ["Barnes and Noble Research"]);
});

test("an ordinary author list still splits and reorders", () => {
  const papers = bib("@article{a, title = {T}, author = {Devlin, Jacob and Chang, Ming-Wei and Kenton Lee}}");
  assert.deepEqual(papers[0].authors, ["Jacob Devlin", "Ming-Wei Chang", "Kenton Lee"]);
});

test("a tilde survives in a URL but is still cleaned in prose", () => {
  // `~` is LaTeX's non-breaking space in prose and a literal character in a URL.
  // Rewriting it everywhere broke every user-directory link.
  const withUrl = bib("@article{a, title = {T}, url = {https://ex.com/~smith/p.pdf}, doi = {10.1/~x}}");
  assert.equal(withUrl[0].url, "https://ex.com/~smith/p.pdf");
  assert.equal(withUrl[0].doi, "10.1/~x");
  // In a title it is still a space.
  const withTitle = bib("@article{a, title = {Fig.~1 Results}}");
  assert.equal(withTitle[0].title, "Fig. 1 Results");
});

test("RIS authors arrive in the same form as BibTeX authors", () => {
  // RIS writes "Family, Given" and the library dedupes authors on display name,
  // so leaving the order alone forked one person into two author rows.
  const fromRis = ris("TY  - JOUR\nAU  - Devlin, Jacob\nTI  - R\nER  - ");
  const fromBib = bib("@article{a, title = {B}, author = {Devlin, Jacob}}");
  assert.deepEqual(fromRis[0].authors, ["Jacob Devlin"]);
  assert.deepEqual(fromRis[0].authors, fromBib[0].authors);
});

test("a RIS file with a UTF-8 BOM keeps its entry type", () => {
  // The BOM made the first TY line unmatchable, so the record lost its type.
  const papers = ris("﻿TY  - JOUR\nAU  - A B\nTI  - BOM Paper\nER  - ");
  assert.equal(papers.length, 1);
  assert.equal(papers[0].title, "BOM Paper");
  assert.equal(papers[0].paperType, "journal");
});

test("RIS multi-line values and repeated author tags are joined", () => {
  const papers = ris(`TY  - CONF
AU  - First Author
AU  - Second Author
TI  - A Very Long Title That
      Continues On The Next Line
ER  - `);
  assert.equal(papers.length, 1);
  assert.deepEqual(papers[0].authors, ["First Author", "Second Author"]);
  assert.match(papers[0].title, /Continues On The Next Line/);
});

test("an empty or contentless file yields nothing rather than throwing", () => {
  assert.deepEqual(bib(""), []);
  assert.deepEqual(ris(""), []);
  assert.deepEqual(bib("just some prose with no entries"), []);
  // CRLF line endings are handled.
  assert.equal(ris("TY  - JOUR\r\nTI  - CRLF Paper\r\nER  - \r\n").length, 1);
});
