# Changelog

All notable changes to Stacks are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Stacks uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Adding a setting no longer requires registering it in three separate lists that
  could silently disagree. A key present in only some of them saved in the
  interface while changing nothing about the request it controlled; the lists are
  now derived from one declaration, and a key without a mapping is a build error.

## [0.3.1] - 2026-07-26

### Added

- The AI model settings have a "Send a temperature value" switch. Newer models
  reject the parameter outright, and which ones cannot be told from a model id,
  so this is a setting rather than a built-in list that goes stale with every
  release.
- The AI feed shows animated dots as the pending turn for as long as the agent
  is working, instead of only before its first message.
- Imports report each stage in the activity log (resolving, downloading,
  storing, saving), with the failure recorded in order at the end.

### Changed

- The settings sections are grouped (Library, AI, Feed, About) and ordered so a
  section sits with what it depends on. Integrations, renamed Connections, holds
  the Bedrock API key and now sits directly above the AI model that uses it
  rather than three sections below it.
- Importing a paper no longer blocks the dialog: it closes immediately and the
  work continues in the activity log.
- The feed's Stop button sits beside the send button, labelled and in the danger
  colour, rather than reading as another attachment icon.
- The feed re-reads settings when its tab regains focus, so changing the default
  model no longer needs a page reload to take effect there.

### Fixed

- arXiv imports survive arXiv throttling. Its API stalls without replying rather
  than refusing, which used to hang the import forever; requests now time out and
  retry, and fall back to the paper's DataCite DOI.
- DOIs that Crossref does not know, such as every `10.48550/arXiv.*`
  registration, now resolve through doi.org instead of reporting "no record".
- Streaming output scrolls continuously instead of jumping a paragraph at a time,
  and opening a long thread lands at the bottom.
- The Continue Reading card caps its author list, like every other author line.
- The "N more authors" button no longer shows a tooltip repeating its own label.
- The URL import screen no longer claims the URL is sent to Jina Reader: pages
  are captured locally, so nothing is sent to a third-party reader service.
- A paper's PDF and HTML snapshot are both always editable, whatever its type.
  Saving a snapshot and then changing the type to a paper used to hide the
  snapshot field, leaving a file that was still on disk and still listed under
  publication details with no way to inspect, replace, or clear it.
- Downloading a source no longer rewrites the paper type: storing an HTML
  snapshot used to switch the record to "website" and discard the type just
  chosen.
- Pressing Escape closes one layer at a time, so leaving the edit window no
  longer also closes the paper detail panel behind it.

## [0.3.0] - 2026-07-25

### Security

- A workflow script can no longer escape its sandbox. An injected helper's
  `.constructor` was the host `Function` constructor, so a script could reach the
  server process, its filesystem, and its shared prototypes. Merely opening a
  saved workflow was enough to trigger it, because reading a script's `meta` runs
  its body.
- The guard against fetching private addresses no longer misses IPv4 addresses
  mapped into IPv6, the unspecified address, trailing-dot hostnames, the full
  IPv6 link-local range, or the carrier, benchmark, and multicast blocks. Every
  redirect hop is now resolved and checked, and headers are dropped when a
  redirect crosses origins.
- Feed file paths are confined to the feed's own directory, closing a traversal
  route out of it.

### Changed

- Every request the browser sends to the app is now validated against a schema
  before it is acted on, so a malformed body is refused with an explanation
  instead of being partially applied.
- Collection cards show what a collection actually contains: the papers in it,
  each one's authors, venue, and year, and how much of it has been read. Every
  card is the same height.
- Tooltips use the app's own styling and appear at the cursor rather than in the
  browser's default position, and only when they add something: a truncated
  paper title, or the full name of a venue shown by acronym.
- The library, author, and venue tables share one sorting and column-resizing
  model. Sorting can be reset to the original order, resizing tracks the cursor,
  and columns stay proportional instead of overflowing their neighbours.
- Author names in the paper form are chips that can be reordered by dragging.
- The library picker in a feed and the collection editor list papers the same way
  the rest of the app does, and search there covers authors, venues, and years
  rather than titles alone.
- The README now covers what Stacks does; implementation notes, deployment, and
  the release process moved to `docs/ARCHITECTURE.md`.
- CI and release workflows run on `actions/checkout@v5` and
  `actions/setup-node@v5`, which no longer warn about the Node 20 deprecation.

### Fixed

- Editing a single paper, author, or venue no longer silently does nothing.
- A malformed save request no longer wipes every saved skill or workflow: it is
  refused, and an explicitly empty list is still a legitimate save.
- Bibliography import no longer loses entries or corrupts fields. One unbalanced
  entry stops swallowing the rest of the file, commented-out entries stay out,
  corporate authors in braces stay whole, and a tilde survives in a URL.
- arXiv identifiers and DOIs are canonicalized, so duplicate detection catches
  the spellings the app itself produces.
- Imported metadata is derived from the URL that was actually fetched rather than
  from the raw request text.
- One unreadable GitHub issue no longer wedges a sync or truncates it silently.
- Reading a workflow's `meta` cannot crash or stall the server, and a comment or
  string mentioning the meta export no longer leaves the workflow nameless.
- Library writes that would store unusable records are rejected rather than
  saved.
- The caret and selection in the highlighted Markdown editors stay aligned with
  the text.

### Removed

- 31 dead CSS blocks that a later copy of the same selector already overrode.

## [0.2.2] - 2026-07-24

### Changed

- Manually adding a paper now uses the same interface as editing one: the
  summary, abstract, and notes fields get the highlighted Markdown editor, and
  papers can be filed into collections at creation.
- Closing or reopening a feed's GitHub issue from another device now collapses
  or expands the feed locally, and comments on closed (collapsed) issues still
  sync. Closed issues that never had a local feed are left alone.
- Switching the GitHub inbox to a different repository now relinks feeds
  safely: all stored issue and comment links are reset first (they belong to
  the old repository), and the next sync mirrors every feed into fresh issues
  in the new one instead of touching same-numbered strangers.

### Fixed

- The caret and text selection in the highlighted Markdown editors (summary,
  abstract, notes) no longer drift off the visible text; shared form styles had
  been reskinning the editor's input layer out of alignment with its display
  layer.
- Browser form-history suggestions no longer stack on top of the app's own
  autocomplete in the add/edit paper, author, venue, and collection forms.
- Feed comments posted from a phone while the agent was mid-run are no longer
  at risk of being skipped permanently: the sync high-water mark only advances
  once every deferred comment has been ingested.
- The sync high-water mark is stamped with a clock-skew margin, so a fast local
  clock can't hide remote changes from incremental pulls.
- Comments ingested in one batch keep their GitHub order in the transcript.
- The attachment-link backfill for old mirrored comments now runs once per
  message instead of re-checking every comment on every sync.

## [0.2.1] - 2026-07-24

### Changed

- Attaching a library paper to a feed no longer copies its PDF into the feed
  folder (which duplicated large files on every turn). The agent reads the
  original through a read-only, token-gated API instead: it fetches the paper's
  metadata and, when there is a stored file, downloads it to a scratch directory
  and reads that. GitHub sync mentions attached papers by title rather than
  re-uploading them.
- Clicking an attached paper in a feed opens that paper in the library in a new
  tab (via a `/?paper=<id>` deep link).
- The theme now stays in sync across open windows: switching light/dark in one
  updates the others without a reload.

### Fixed

- Deleting a feed that was mirrored to GitHub now closes its issue through a
  durable, repo-scoped outbox (retried on the next sync and on startup if GitHub
  is unreachable), so the feed no longer reappears, rebuilt from scratch, on a
  later sync, even across an app restart or offline delete.
- A feed created from a GitHub issue no longer shows its instruction twice when
  the issue body repeats the title.
- The opening message of a feed keeps showing the text you typed even when a
  paper is attached.
- The library-picker search box takes focus when it opens, so typing filters the
  list instead of landing in the composer behind it.

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

[Unreleased]: https://github.com/SXKDZ/Stacks/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/SXKDZ/Stacks/releases/tag/v0.3.1
[0.3.0]: https://github.com/SXKDZ/Stacks/releases/tag/v0.3.0
[0.2.2]: https://github.com/SXKDZ/Stacks/releases/tag/v0.2.2
[0.2.1]: https://github.com/SXKDZ/Stacks/releases/tag/v0.2.1
[0.2.0]: https://github.com/SXKDZ/Stacks/releases/tag/v0.2.0
[0.1.1]: https://github.com/SXKDZ/Stacks/releases/tag/v0.1.1
[0.1.0]: https://github.com/SXKDZ/Stacks/releases/tag/v0.1.0
