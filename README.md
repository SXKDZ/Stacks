# Stacks

Stacks is a browser-based research library and reading workspace. It combines
normalized paper metadata, authors, venues, collections, local documents,
Markdown/LaTeX summaries, academic search, and an AI feed that drives headless
agents over your library.

## Highlights

- Normalized SQLite data model with ordered `paper_authors`, canonical venues,
  and many-to-many collections.
- Searchable, sortable, resizable paper grid plus compact author and venue
  indexes with bulk edit and delete.
- Full create, edit, and delete flows for papers, authors, venues, and
  collections.
- Click-through author, venue, and collection links that open their papers.
- Embedded PDF and local HTML readers.
- Markdown, GitHub-flavored Markdown, and LaTeX rendering through KaTeX.
- Bedrock-powered summaries with configurable model and prompt templates.
- An AI feed that runs headless `claude -p` agents; every library change is an
  approval-gated proposal, optionally mirrored to a private GitHub repo's issues.
- Semantic Scholar, Google Scholar through SerpAPI, arXiv, DBLP, and Crossref
  discovery with no cross-provider fallback.
- Light and dark themes using Inter and Lucide icons.

## Data model

A local SQLite library (better-sqlite3, via Drizzle) is the only active
database. All reads and edits go through `app/api/library/route.ts`. The library
lives in a single self-contained folder (defaulting to `~/.stacks/library`)
holding `library.db`, managed `pdfs/` and `html_snapshots/`, and `settings.json`.

## Local setup

Requirements: Node.js 22.13 or newer.

```bash
cd Stacks
npm install
cp .env.example .env   # optional: see Configuration
npm run dev
```

Open <http://localhost:3000>.

`.env` is an ignored bootstrap source for secrets and the library location.
Settings changed in the UI are written atomically to `settings.json` inside the
library folder with owner-only permissions; Stacks does not rewrite `.env` or
expose saved secrets.

## Deployment

Stacks is a Next.js app served on Node. It is local-first and single-user: the
server binds to `127.0.0.1` on purpose and ships no authentication of its own.
Run it on the machine that holds your library, or behind a reverse proxy that
adds access control (see Exposing Stacks below).

### Build and run

```bash
npm ci               # reproducible install from package-lock.json
npm run build        # compile the production bundle into .next
npm run start        # serve the built app on 127.0.0.1:3000
```

`npm run build` needs the same env as runtime only if you build on the target
host; the bundle itself reads all secrets at request time from `settings.json`
or the environment, so a build produced anywhere runs the same. To change the
port, pass it through to Next:

```bash
npm run start -- --port 8080
```

### System dependencies

- Node.js 22.13 or newer (`engines` enforces this).
- A C toolchain for `better-sqlite3`. It installs a prebuilt binary on common
  platforms; if none matches, `npm ci` compiles it and needs `python3`, `make`,
  and a C++ compiler (`build-essential` on Debian/Ubuntu, Xcode CLT on macOS).
- Playwright Chromium, used to save HTML snapshots of web sources. Install the
  browser once per host: `npx playwright install chromium` (add
  `--with-deps` on Linux to pull the shared libraries).
- The `claude` CLI, only for the AI feed. Install it with
  `npm i -g @anthropic-ai/claude-code` and make sure it is on `PATH` (or point
  `STACKS_CLAUDE_BIN` at it). Storage doctor in Settings reports whether it was
  found. Everything except the feed works without it.

### Persistent storage

The library folder is the entire state: `library.db`, `pdfs/`,
`html_snapshots/`, `settings.json`, and the feed transcripts. It defaults to
`~/.stacks/library`; set `STACKS_LIBRARY_DIR` to place it on a persistent,
writable volume. Back it up with Settings → OneDrive sync, or by copying the
folder while the server is stopped. In a container, mount this directory as a
named volume so it survives image rebuilds.

### Running as a service

Keep the process alive with your init system. A minimal systemd unit:

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

`pm2 start npm --name stacks -- run start` works the same way. The database
migrates itself on boot (`db/bootstrap.ts`), so no separate migration step is
needed on deploy.

### Exposing Stacks

Because the app has no login, do not bind it to a public interface directly.
To reach it remotely, front it with a reverse proxy (nginx, Caddy, or a
Cloudflare/Tailscale tunnel) that terminates TLS and enforces authentication,
and proxy to `127.0.0.1:3000`. Outbound source fetches are guarded against SSRF
to loopback and private hosts, but that is not a substitute for an auth layer in
front of the app. For phone access to the feed without exposing the server, use
Settings → Integrations to mirror feeds to a private GitHub repo's issues
instead.

## OneDrive backup

Settings → OneDrive sync creates a consistent SQLite backup of the library and
mirrors managed `pdfs/` and `html_snapshots/` files. The local library remains
authoritative while the server is running, so Sync never replaces or mutates the
live database. It is a one-way backup, and a restore is an explicit offline
operation. The remote path and auto-backup cadence are configured in Settings.

## Configuration

Stacks reads almost all configuration from the in-app Settings (stored in the
library's `settings.json`), so you normally need no env vars. The ignored `.env`
is only for seeding secrets or the library location before the UI is used:

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

## Architecture

```text
app/components/       React UI and interaction surfaces
app/api/              library CRUD, discovery, import, AI, feed, and settings routes
app/lib/              shared types, prompts, Bedrock, feed agent, and scholarly providers
db/                   normalized Drizzle schema and self-migrating SQLite bootstrap
scripts/              color-audit, release, and OneDrive backup bridge
tests/                build, schema, UI-contract, and secret-safety checks
```

The browser and backend ship together. `app/api/` contains the route handlers,
and `db/` provides persistence via a local better-sqlite3 `library.db` file
served by Next.js on Node. Drizzle is the query layer; `db/bootstrap.ts` creates
and migrates the schema idempotently on boot, so there is no separate migration
step. There is no Cloudflare, Wrangler, or D1 runtime.

## Verification

```bash
npm run lint
npm exec tsc -- --noEmit
npm test
```

## Releasing

Stacks follows [Semantic Versioning](https://semver.org): patch for fixes, minor
for backward-compatible features, major for breaking changes. The running
version comes from `package.json`, and `CHANGELOG.md` records every release in
[Keep a Changelog](https://keepachangelog.com) format.

Note user-facing changes under `## [Unreleased]` in `CHANGELOG.md` as you work.
Releases are tag-driven, so nothing ever pushes directly to the protected
`main`. From a clean `main` in sync with origin, with `gh` authenticated:

```bash
npm run release -- minor --dry-run   # preview: version bump + notes, no changes
npm run release -- minor             # or patch | major | an explicit X.Y.Z
```

`release` **prepares** the release: it bumps `package.json`, rolls the
`Unreleased` notes into a dated version entry on a `release/vX.Y.Z` branch, and
opens a PR. Review and merge it like any change (CI must pass). Then tag the
merge commit to publish:

```bash
git checkout main && git pull
git tag -a vX.Y.Z -m "Stacks X.Y.Z" && git push origin vX.Y.Z
```

The push triggers `.github/workflows/release.yml`, which re-runs lint, typecheck,
and tests, then creates the GitHub release from that version's `CHANGELOG.md`
section. Stacks checks that release feed in Settings → About & updates and
reports when a newer version is published; it never updates itself, so a local
install updates by pulling the repo and running `npm install`, and a hosted
install updates on redeploy.
