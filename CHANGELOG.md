# Changelog

All notable changes to Stacks are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Stacks uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-23

### Added

- Per-feed agent model picker in the composer and reply box: choose the Bedrock
  model for a feed, persisted on the feed and passed to the agent, recorded as a
  system notice in the thread, with the last-used model restored for new feeds.
- One reusable dropdown control used everywhere a select is needed (feed model
  picker, AI settings, filter builder, entity forms), replacing native selects
  so the option list matches the app's own styling.
- Clickable author names and collection chips in the paper list that filter the
  library by that author or collection.
- A one-time OneDrive backup on startup when auto-backup is configured, so
  changes made while Stacks was closed are protected on the next launch.
- Continuous integration (lint, typecheck, build, and tests) on every pull
  request and push, with the main branch protected behind it.

### Changed

- Refreshed the interface: a modern type scale (Geist), a single theme-aware
  brand gradient, rounder buttons, and consolidated spacing, radii, borders, and
  colors so surfaces stay consistent across light and dark themes.
- Proposal cards now show the change action (e.g. "Create paper") alongside the
  paper type and venue, and expand in place to the structured change details
  with the raw JSON tucked inside.
- The OneDrive sync card reports the configured backup state and last backup
  time instead of always reading as not-yet-connected after a restart.
- The library view and an open feed now refresh each other's changes on tab
  focus, retiring the manual refresh button.

### Fixed

- Feed HTML/SVG attachments are served as downloads with a strict content
  policy, so a captured web page's scripts can never run inside the app.
- The workflow runtime no longer exposes host internals to a workflow script.
- Enforced unique arXiv and Semantic Scholar identifiers on papers, made
  proposal approval and GitHub sync safe against overlapping runs, and stopped
  the demo library from reappearing after every paper is deleted.
- Feed attachments and agent sessions are cleaned up on delete and carried along
  when the library folder moves; re-downloading a source now refreshes the file.
- A failed agent launch now surfaces as an error instead of leaving a feed stuck
  loading; an empty filter clause no longer hides every paper; and bulk delete or
  export only ever acts on the papers currently in view.

## [0.1.1] - 2026-07-23

### Removed

- The unused drizzle-kit migration folder, config, `db:generate` script, and
  dependency. `db/bootstrap.ts` is the single, self-migrating schema source and
  Drizzle remains the query layer.
- The stale OpenGraph social image and its metadata; a local app serves no
  shared link previews.

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

[Unreleased]: https://github.com/SXKDZ/Stacks/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/SXKDZ/Stacks/releases/tag/v0.2.0
[0.1.1]: https://github.com/SXKDZ/Stacks/releases/tag/v0.1.1
[0.1.0]: https://github.com/SXKDZ/Stacks/releases/tag/v0.1.0
