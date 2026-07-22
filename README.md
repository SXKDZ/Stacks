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
cd PaperAssistant
npm install
cp .env.example .env   # optional — see Configuration
npm run dev
```

Open <http://localhost:3000>.

`.env` is an ignored bootstrap source for secrets and the library location.
Settings changed in the UI are written atomically to `settings.json` inside the
library folder with owner-only permissions; Stacks does not rewrite `.env` or
expose saved secrets.

## OneDrive backup

Settings → OneDrive sync creates a consistent SQLite backup of the library and
mirrors managed `pdfs/` and `html_snapshots/` files. The local library remains
authoritative while the server is running, so Sync never replaces or mutates the
live database — it is a one-way backup. A restore is an explicit offline
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
- `STACKS_LIBRARY_DIR` (must be an env var — read before `settings.json`)
- `STACKS_GITHUB_REPO`
- `GITHUB_TOKEN`

Never commit `.env`, `settings.json`, or database files.

## Architecture

```text
app/components/       React UI and interaction surfaces
app/api/              library CRUD, discovery, import, AI, feed, and settings routes
app/lib/              shared types, prompts, Bedrock, feed agent, and scholarly providers
db/                   normalized Drizzle schema and SQLite bootstrap
drizzle/              generated SQL migrations
scripts/              color-audit and OneDrive backup bridge
tests/                build, schema, UI-contract, and secret-safety checks
```

The browser and backend ship together. `app/api/` contains the route handlers,
and `db/` and `drizzle/` provide persistence via a local better-sqlite3
`library.db` file served by Next.js on Node — there is no Cloudflare, Wrangler,
or D1 runtime.

## Verification

```bash
npm run lint
npm exec tsc -- --noEmit
npm test
npm run db:generate
```
