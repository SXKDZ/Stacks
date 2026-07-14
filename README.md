# Paper Assistant

Paper Assistant (PA) is a browser-based research library and reading workspace.
It combines normalized paper metadata, authors, venues, collections, local
documents, Markdown/LaTeX summaries, academic search, and paper-grounded chat.

## Highlights

- Normalized D1 data model with ordered `paper_authors`, canonical venues, and
  many-to-many collections.
- Searchable, sortable, resizable paper grid plus compact author and venue
  indexes with bulk edit and delete.
- Full create, edit, and delete flows for papers, authors, venues, and
  collections.
- Click-through author, venue, and collection links that open their papers.
- Embedded PDF and local HTML readers.
- Markdown, GitHub-flavored Markdown, and LaTeX rendering through KaTeX.
- Bedrock-powered summaries and multi-paper discussion with configurable model
  and prompt templates.
- Semantic Scholar, Google Scholar through SerpAPI, arXiv, DBLP, and Crossref
  discovery with no cross-provider fallback.
- Light and dark themes using Inter and Lucide icons.

## Data model

D1 is PA's only active database. All reads and edits go through
`app/api/library/route.ts`; there is no legacy SQLite CRUD adapter.

The original CLI SQLite database may be used once as a read-only import source:

```bash
PA_LEGACY_IMPORT_DIR=~/.papercli npm run db:import-legacy
```

The importer produces an ignored SQL file, loads the local D1 store, and never
writes to the source database. Imported PDF and HTML paths continue to resolve
read-only from `PA_LEGACY_IMPORT_DIR`. Newly selected files are copied into
PA-managed `data/pdfs/` or `data/html_snapshots/` storage.

## Local setup

Requirements: Node.js 22.13 or newer.

```bash
cd PaperAssistant
npm install
cp .env.example .env
npm run db:import-legacy
npm run dev -- --host 0.0.0.0 --port 8000
```

Open <http://localhost:8000>.

`.env` is an ignored bootstrap source. Settings changed in the UI are written
atomically to ignored `data/settings.json` with owner-only permissions; PA does
not rewrite `.env` or expose saved secrets.

## OneDrive backup

Settings → OneDrive sync creates a consistent SQLite backup of the normalized
D1 library and mirrors PA-managed `pdfs/` and `html_snapshots/` files. D1
remains authoritative while the server is running, so Sync never replaces or
mutates the live database. A remote restore is an explicit offline operation.

Relevant bootstrap settings are:

- `PA_ONEDRIVE_PATH`
- `PA_AUTO_SYNC`
- `PA_AUTO_SYNC_INTERVAL`

## Configuration

The ignored `.env` can provide:

- `AWS_BEARER_TOKEN_BEDROCK`
- `AWS_REGION`
- `BEDROCK_MODEL_ID`
- `PA_MAX_TOKENS`
- `PA_TEMPERATURE`
- `PA_CHAT_SYSTEM_PROMPT`
- `PA_SUMMARY_SYSTEM_PROMPT`
- `SEMANTIC_SCHOLAR_API_KEY`
- `SERPAPI_KEY`
- `JINA_API_KEY`
- `PA_LEGACY_IMPORT_DIR`
- `PA_ONEDRIVE_PATH`
- `PA_AUTO_SYNC`
- `PA_AUTO_SYNC_INTERVAL`

Never commit `.env`, `data/settings.json`, D1 state, generated import SQL, or
database files.

## Architecture

```text
app/components/       React UI and interaction surfaces
app/api/              library CRUD, discovery, import, AI, and settings routes
app/lib/              shared types, prompts, Bedrock, and scholarly providers
db/                   normalized Drizzle schema and D1 bootstrap
drizzle/              generated SQL migrations
build/                PA settings, local-file, and Sites/Vite integrations
scripts/              read-only legacy importer and OneDrive backup bridge
worker/               Cloudflare worker entry
tests/                build, schema, UI-contract, and secret-safety checks
```

The browser and backend ship together. `app/api/` contains the route handlers;
`db/`, `drizzle/`, and `worker/` provide persistence and deployment; local
development uses Wrangler's D1 state under `.wrangler/`.

## Verification

```bash
npm run lint
npm exec tsc -- --noEmit
npm test
npm run db:generate
```
