# Architecture and development

Implementation notes for working on Stacks. For what the app does, see the [README](../README.md).

## Stack

Stacks is a Next.js app (App Router, React 19) served on Node. The browser UI and the backend ship together: `app/api/` holds the route handlers and `db/` provides persistence through a local better-sqlite3 file. It is local-first and single-user by design; there is no Cloudflare, Wrangler, or D1 runtime.

```text
app/components/       React UI and interaction surfaces
app/api/              library CRUD, discovery, import, AI, feed, and settings routes
app/lib/              shared types, prompts, Bedrock, feed agent, and scholarly providers
app/styles/           hand-written CSS skin over a design-token layer
db/                   normalized Drizzle schema and self-migrating SQLite bootstrap
docs/                 this document
scripts/              color-audit, release, and OneDrive backup bridge
tests/                build, schema, UI-contract, and secret-safety checks
```

## Data model

A local SQLite library (better-sqlite3, via Drizzle) is the only active database. All reads and edits go through `app/api/library/route.ts`.

`db/schema.ts` is the typed query layer and `db/bootstrap.ts` is the authoritative schema: it creates tables, adds columns, and backfills data idempotently on boot, so there is no separate migration step and no migration files. Schema changes belong in both files.

Core tables:

- `papers`: one row per work, with unique indexes on `doi`, `arxiv_id`, and `semantic_scholar_id` so import dedup is enforced by the database rather than a check-then-insert race.
- `authors` + `paper_authors`: authors are first-class records; the join table carries `author_order` (unique per paper) and a `corresponding` flag.
- `venues`: canonical venues referenced by papers.
- `collections` + `paper_collections`: many-to-many membership.
- `feed_snippets`, `feed_messages`, `feed_proposals`: one feed per agent conversation, its transcript, and the approval-gated library mutations it proposed.
- `feed_github_outbox`: durable, repo-scoped queue for GitHub actions that must land even if the app is offline when they are triggered.

## The library folder

One self-contained directory holds all state, defaulting to `~/.stacks/library` and relocatable with `STACKS_LIBRARY_DIR`:

```text
library.db          the SQLite database
pdfs/               managed PDF storage
html_snapshots/     saved web sources
settings.json       user settings and secrets (owner-only permissions)
feed/               per-feed agent working directories and transcripts
```

Copying this folder (with the server stopped) is a complete backup.

## The AI feed

Feeds run the `claude` CLI headlessly (`claude -p`), one process per turn, from `app/lib/feed-agent.ts`. Each feed gets a sandboxed working directory under `<library>/feed/<snippetId>/`; `--add-dir` grants the agent that directory plus `/tmp` for scratch space, and sessions resume across turns via `--session-id` / `--resume`.

Agents never write to the library. They operate it through HTTP routes under `/api/feed/`, authenticated with a per-run bearer token (`app/lib/feed-token.ts`) that maps back to the one feed that owns it. Any mutation the agent wants becomes a row in `feed_proposals` with `pending` status, applied only when the user approves it. Reads of stored papers go through token-gated, read-only endpoints (`/api/feed/library/papers/[id]` for metadata and `.../file` for the document), so an attached paper is referenced by id and read in place instead of being copied into the feed directory.

## GitHub inbox sync

`app/api/feed/github/sync/route.ts` reconciles feeds with issues in one manual pass, and `app/lib/github-sync.ts` is a minimal REST client pinned to `api.github.com` with redirects refused.

- **Outbound**: create an issue per feed, push local renames and collapse state, mirror new prose messages and proposal statuses as comments.
- **Inbound**: adopt remote renames and close/reopen (as the collapsed flag), ingest new and edited human comments, and turn new open issues into feeds. New comments trigger one reply turn.

Invariants worth preserving when touching this code:

- **Loop safety**: Stacks-authored comments carry an HTML-comment marker, and every mirrored or ingested message stores its comment id, so output is never re-ingested as new input.
- **One sync at a time**: a module-scope flag serializes runs; the unique index on `feed_snippets.issue_number` is the database backstop.
- **Repo scoping**: issue and comment ids only mean something in the repo they were created in. `github.linkedRepo` in settings records which repo the local links belong to; when the configured repo changes, every link is cleared before syncing so a stale number can't touch an unrelated issue.
- **Conservative high-water mark**: the incremental `since` filter only advances when nothing was truncated by the page cap and nothing was deferred (a feed whose agent was mid-run), and it is stamped with a clock-skew margin because GitHub filters against its own clock.
- **Deletion is authoritative**: deleting a mirrored feed queues a close in `feed_github_outbox`, drained on delete, at sync start, and on startup. Inbound never creates a feed from a closed unlinked issue, so a deleted feed cannot resurrect.

## Styling

`app/styles/` is a hand-written CSS skin built on a design-token layer, loaded in a deliberate import order (see `app/globals.css`) where later files win ties. Tailwind and CVA are installed but the visual language lives in these files.

Two conventions to respect:

- Overlay editors (`MarkdownCodeEditor`) stack a transparent `<textarea>` on a highlighted `<pre>`. Any context rule that restyles the textarea's metrics (padding, line-height, border, min/max-height, margin) desyncs the caret and selection from the visible glyphs, so form skins exclude the editor's inner textarea via `:not(:where(.prompt-code-editor *))`.
- User-facing copy uses no em dashes, and avoids captions that restate what a control obviously does.

## Configuration

Almost all configuration is read from the in-app Settings, persisted atomically to `settings.json` in the library folder with owner-only permissions. Stacks never rewrites `.env` and never exposes saved secrets back to the client.

The ignored `.env` is only a bootstrap source for secrets or the library location before the UI is used:

- `AWS_BEARER_TOKEN_BEDROCK`
- `AWS_REGION`
- `BEDROCK_MODEL_ID`
- `SEMANTIC_SCHOLAR_API_KEY`
- `SERPAPI_KEY`
- `STACKS_LIBRARY_DIR` (must be an env var: read before `settings.json`)
- `STACKS_GITHUB_REPO`
- `GITHUB_TOKEN`
- `STACKS_CLAUDE_BIN` (path to the `claude` CLI if it is not on `PATH`)

Never commit `.env`, `settings.json`, or database files.

## Verification

```bash
npm run lint
npm exec tsc -- --noEmit
npm test
```

`npm test` runs a production build first, then the Node test suites. The suites in `tests/` assert structural contracts by reading source files: schema shape, UI invariants, secret safety, and the sync guarantees listed above. When you change one of those deliberately, update the corresponding assertion in the same commit.

To verify a build without clobbering `.next`, use an isolated output directory:

```bash
NEXT_DIST_DIR=.next-verify npm run build
git checkout tsconfig.json   # Next rewrites it during a build
```

## Deployment

```bash
npm ci               # reproducible install from package-lock.json
npm run build        # compile the production bundle into .next
npm run start        # serve the built app on 127.0.0.1:3000
npm run start -- --port 8080   # or on another port
```

Secrets are read at request time from `settings.json` or the environment, so a bundle built anywhere runs the same.

### System dependencies

- Node.js 22.13 or newer (`engines` enforces this).
- A C toolchain for `better-sqlite3`. It installs a prebuilt binary on common platforms; if none matches, `npm ci` compiles it and needs `python3`, `make`, and a C++ compiler (`build-essential` on Debian/Ubuntu, Xcode CLT on macOS).
- Playwright Chromium for HTML snapshots: `npx playwright install chromium` (add `--with-deps` on Linux).
- The `claude` CLI for the AI feed: `npm i -g @anthropic-ai/claude-code`.

### Running as a service

The database migrates itself on boot, so deploys need no migration step.

```ini
[Service]
WorkingDirectory=/opt/stacks
Environment=STACKS_LIBRARY_DIR=/var/lib/stacks/library
ExecStart=/usr/bin/npm run start
Restart=on-failure
User=stacks

[Install]
WantedBy=multi-user.target
```

`pm2 start npm --name stacks -- run start` works the same way. In a container, mount the library directory as a named volume so it survives image rebuilds.

### Exposing Stacks

The app ships no authentication and binds to `127.0.0.1` deliberately. To reach it remotely, front it with a reverse proxy (nginx, Caddy, or a Cloudflare/Tailscale tunnel) that terminates TLS and enforces authentication, proxying to `127.0.0.1:3000`. Outbound source fetches are guarded against SSRF to loopback and private hosts, but that is not a substitute for an auth layer.

## Releasing

Stacks follows [Semantic Versioning](https://semver.org): patch for fixes, minor for backward-compatible features, major for breaking changes. The running version comes from `package.json`, and `CHANGELOG.md` records every release in [Keep a Changelog](https://keepachangelog.com) format.

Note user-facing changes under `## [Unreleased]` in `CHANGELOG.md` as you work. Releases are tag-driven, so nothing ever pushes directly to the protected `main`. From a clean `main` in sync with origin, with `gh` authenticated:

```bash
npm run release -- minor --dry-run   # preview: version bump + notes, no changes
npm run release -- minor             # or patch | major | an explicit X.Y.Z
```

`release` **prepares** the release: it bumps `package.json`, rolls the `Unreleased` notes into a dated version entry on a `release/vX.Y.Z` branch, and opens a PR. Review and merge it like any change (CI must pass). Then tag the merge commit to publish:

```bash
git checkout main && git pull
git tag -a vX.Y.Z -m "Stacks X.Y.Z" && git push origin vX.Y.Z
```

The push triggers `.github/workflows/release.yml`, which re-runs lint, typecheck, and tests, then creates the GitHub release from that version's `CHANGELOG.md` section. Stacks surfaces that release feed in Settings → About and reports when a newer version is published; it never updates itself, so a local install updates by pulling the repo and running `npm install`, and a hosted install updates on redeploy.
