# Changelog

All notable changes to Stacks are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Stacks uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-23

Initial public release.

### Added

- Normalized local SQLite library (better-sqlite3 via Drizzle) with ordered
  paper authorship, canonical venues, and many-to-many collections, all in a
  single self-contained library folder.
- Searchable, sortable, resizable paper grid plus compact author and venue
  indexes, with full create, edit, delete, and bulk actions.
- Click-through author, venue, and collection links, and collections that carry
  a color shown on their cards and paper chips.
- Embedded PDF and local HTML readers with Markdown, GitHub-flavored Markdown,
  and LaTeX rendering through KaTeX.
- Bedrock-powered summaries grounded in the stored PDF, with configurable model
  and prompt templates.
- Academic discovery across Semantic Scholar, Google Scholar (via SerpAPI),
  arXiv, DBLP, and Crossref, plus BibTeX, RIS, and identifier imports.
- An AI feed that drives headless `claude -p` agents over the library, where
  every change is an approval-gated proposal, with editable feed skills and
  Claude Code workflow scripts.
- Optional GitHub inbox sync that mirrors feeds to a private repo's issues for
  mobile access.
- One-way OneDrive backup of the library, database, managed files, and feed
  transcripts.
- Light and dark themes, and an in-app update check against GitHub releases.

[Unreleased]: https://github.com/SXKDZ/Stacks/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SXKDZ/Stacks/releases/tag/v0.1.0
