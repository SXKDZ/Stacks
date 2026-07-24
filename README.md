# Stacks

A research library and reading workspace that runs in your browser, on your own machine. Papers, authors, venues, and collections are stored as linked records, PDFs are kept alongside them, and AI agents can work over the collection through changes you approve.

The name is a promise: your stacks will not overflow using our library.

## Library

Authors, venues, and collections are records, not text on a row. One author is the same entity across every paper they wrote, so correcting a name corrects it everywhere, and clicking any name, venue, or collection opens the papers filed under it.

Papers list in a table you can search, sort, and filter, and edit in bulk.

## Adding papers

Six ways in, depending on what you have:

- Search Semantic Scholar, arXiv, DBLP, Crossref, or Google Scholar.
- Paste a DOI, arXiv id, or similar identifier.
- Import a BibTeX or RIS file.
- Drop in a local PDF and let Stacks read the details out of it.
- Paste a URL to a paper, publisher page, or PDF.
- Type it in, with autocomplete from what you already have.

When a source is available, Stacks stores the PDF or an HTML snapshot of the page, so what you read stays readable if the original moves. Identifiers are unique, so importing the same paper twice won't fork it.

## Reading

PDFs and saved snapshots open in a reader inside the app. Each paper holds a summary, an abstract, and your notes, written in Markdown with LaTeX math.

## AI feed

The feed runs headless Claude Code agents against your library: summarize a paper you just added, compare the work in a collection, find what you haven't read.

Agents don't write to the library. When one wants to add a paper, change metadata, or file something into a collection, it produces a proposal, and nothing lands until you approve it. Documents are exposed read-only, so an agent can't delete or overwrite a file.

Feeds can mirror to a private GitHub repository as issues, so the GitHub mobile app works as a remote inbox: open an issue to start a feed, comment to reply, close it to shelve the thread. Both sides stay in step without putting your library on the internet.

## Backup

A one-way backup copies the database and stored documents to OneDrive or any synced folder, on a schedule you set. The local library stays authoritative; backing up never modifies it.

## Getting started

Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. Your library folder is created at `~/.stacks/library`; set `STACKS_LIBRARY_DIR` to keep it elsewhere.

Configuration lives in Settings. Some features need more:

- Summaries and the feed need AWS Bedrock credentials.
- The feed also needs the `claude` CLI on your `PATH` (`npm i -g @anthropic-ai/claude-code`).
- HTML snapshots need Playwright's Chromium (`npx playwright install chromium`).
- Google Scholar search needs a SerpAPI key. The other providers don't.

Settings → About reports what was found.

## Access

Stacks is single-user: it listens on `127.0.0.1` and has no login. Don't put it on a public address as-is. To use it remotely, run it behind a reverse proxy or a Tailscale/Cloudflare tunnel that handles authentication, or use the GitHub mirror for phone access.

## Docs

- [Architecture and development](docs/ARCHITECTURE.md) for codebase layout, data model, deployment, and releases.
- [CHANGELOG.md](CHANGELOG.md) for what changed in each version.
