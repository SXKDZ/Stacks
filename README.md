# Paper Assistant

Paper Assistant (PA) is a modern browser-based reading workspace for the
PaperCLI library. It keeps papers, authors, venues, collections, summaries,
notes, stored documents, and paper-aware chat together in one interface.

## What is included

- Overview and searchable library views with reading state, favorites, notes,
  collections, and the full PaperCLI publication metadata set.
- Normalized author and venue records. Papers link to ordered authors through
  `paper_authors` and to a venue by foreign key, so a rename propagates across
  the whole library.
- Compact author and venue tables with selection, bulk update, bulk delete,
  individual editing, and one-click filtering to linked papers.
- Complete create/edit/delete flows for papers, authors, venues, and
  collections, including PaperCLI paths, identifiers, summaries, and notes.
- An in-app PDF/HTML reader for files already stored by PaperCLI.
- Stored and on-demand summaries plus paper-grounded Bedrock chat.
- Semantic Scholar and Google Scholar discovery and Jina Reader URL imports.
- A local Settings workspace for the Bedrock model, generation parameters,
  integration keys, PaperCLI paths, and OneDrive sync.
- Responsive light and dark themes using Inter for a coherent interface and
  JetBrains Mono for prompt placeholders, without an account or user-profile system.

## Local data behavior

In development, PA looks for `~/.papercli/papers.db`. The local Vite plugin
creates an ignored demonstration copy at `data/papercli-demo.db`, upgrades
that copy with PA-only fields, and exposes it to the app. Normal PA library
editing never mutates the original PaperCLI database.

Existing `pdf_path` and `html_snapshot_path` values are served read-only from
the PaperCLI data directory so they open inside PA. If the database is absent,
the app falls back to the included demo data and local D1 store.

Set `PAPERCLI_DATA_DIR` before starting PA to use a non-default PaperCLI data
directory. Remove `data/papercli-demo.db` if you want to refresh the safe
demonstration copy from the source database.

## OneDrive sync

The Settings → OneDrive sync panel mirrors PaperCLI's directory contract. It
synchronizes the live PaperCLI `papers.db`, `pdfs/`, and `html_snapshots/`
between `PAPERCLI_DATA_DIR` and `PAPERCLI_REMOTE_PATH`, uses the same 30-minute
lock-file boundary, and supports these conflict policies:

- Prefer local PaperCLI
- Prefer OneDrive
- Keep both conflict copies and use the newest database as canonical

Manual sync is an explicit action because it can change both live directories.
Auto-sync watches the live PaperCLI database and runs after the configured
delay, using local-wins conflict handling like PaperCLI's background sync. The
safe PA demonstration copy remains separate.

## Setup

Requirements: Node.js 22.13 or newer.

```bash
cd PaperAssistant
npm install
cp .env.example .env
npm run dev -- --port 8000
```

Open <http://localhost:8000>.

The ignored `.env` file is a read-only bootstrap source for:

- `SERPAPI_KEY`
- `AWS_BEARER_TOKEN_BEDROCK`
- `AWS_REGION` (defaults to `us-east-1`)
- `BEDROCK_MODEL_ID`
- `PA_MAX_TOKENS`
- `PA_TEMPERATURE`
- `JINA_API_KEY`
- `SEMANTIC_SCHOLAR_API_KEY`
- `PAPERCLI_DATA_DIR`
- `PAPERCLI_REMOTE_PATH`
- `PAPERCLI_AUTO_SYNC`
- `PAPERCLI_AUTO_SYNC_INTERVAL`
- `PAPERCLI_SYNC_POLICY`

Changes made in Settings are written atomically to ignored
`data/settings.json` with owner-only permissions. PA never rewrites `.env`, so
saving a model, prompt, integration key, or sync option does not restart the
development server. Hosted deployments continue to use deployment environment
variables. Never commit `.env`, `data/settings.json`, or `data/*.db`.

## Architecture

```text
app/components/       React application and interaction surfaces
app/api/              Bedrock, discovery, import, summary, and D1 APIs
app/lib/              shared types and fallback demo data
db/                   normalized Drizzle schema and D1 bootstrap
build/                local PaperCLI adapter and Sites/Vite integration
drizzle/              generated SQL migrations
scripts/              dependency-free PaperCLI/OneDrive sync bridge
tests/                build, data-model, and secret-safety checks
```

The hosted data model uses Cloudflare D1 through Drizzle. Local PaperCLI
development uses a compatibility adapter over the safe SQLite copy so the same
frontend mutation contract works in both environments.

### Backend implementation

The repository ships the complete backend used by the website. Route handlers
under `app/api/` provide library CRUD, imports, academic discovery, summaries,
paper-grounded chat, Bedrock model discovery, and settings. `db/` and
`drizzle/` define and migrate the normalized D1 data model. Local development
uses the adapters in `build/` plus `scripts/papercli_sync_bridge.py` for the
safe PaperCLI SQLite copy, local documents, and OneDrive synchronization. The
`worker/` entry packages those services for the hosted runtime.

## Verification

```bash
npm run lint
./node_modules/.bin/tsc --noEmit
npm test
npm run db:generate
```

`npm test` includes a production build and validates the normalized data model
and secret-handling boundaries.
