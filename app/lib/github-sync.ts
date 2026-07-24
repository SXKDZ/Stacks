/**
 * A tiny GitHub REST client for the feed inbox sync. Stacks runs on the user's
 * laptop, so a private GitHub repo acts as a remote inbox they can read and
 * write from any device (e.g. the GitHub mobile app): each feed maps to one
 * issue, each message to a comment. This module only talks to the Issues API of
 * one configured repo — it never touches the library itself.
 *
 * Security: every request is pinned to https://api.github.com with a fixed
 * owner/repo, so a malformed setting can't redirect requests elsewhere.
 */

const API_ROOT = "https://api.github.com";

/** Comments Stacks itself posted carry this marker so sync never re-ingests
 *  agent output as a new human instruction. It's an HTML comment, invisible in
 *  the rendered issue on GitHub. */
export const STACKS_MARKER = "<!-- stacks:agent -->";

export interface GitHubConfig {
  /** "owner/repo" */
  repo: string;
  token: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  updatedAt: string;
  /** GitHub marks issues that are actually PRs; we skip those. */
  isPullRequest: boolean;
}

export interface GitHubComment {
  id: number;
  body: string;
  updatedAt: string;
  /** True when the body carries the Stacks agent marker (i.e. we posted it). */
  fromStacks: boolean;
}

export class GitHubError extends Error {
  /** The HTTP status that caused it, or 0 for client-side/validation errors. */
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

function parseRepo(repo: string): { owner: string; name: string } {
  const match = repo.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) {
    throw new GitHubError('Set the GitHub repo as "owner/name" (e.g. octocat/stacks-inbox).');
  }
  return { owner: match[1], name: match[2] };
}

// A defensive ceiling on pages walked per list, so a runaway Link chain can't
// loop forever. 20 pages × 100/page = 2000 items, far above a personal inbox.
const MAX_PAGES = 20;

async function githubRequest(
  config: GitHubConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${API_ROOT}${path}`;
  // Only ever talk to api.github.com, even when following a paginated Link URL.
  if (!url.startsWith(API_ROOT)) {
    throw new GitHubError("Refusing to follow a link outside api.github.com.");
  }
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...init.headers,
    },
    redirect: "error",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const hint = response.status === 401 || response.status === 403
      ? " Check the token has issues:write on this repo."
      : response.status === 404
        ? " Check the repo exists and the token can see it."
        : "";
    throw new GitHubError(`GitHub API ${response.status}.${hint}${detail ? ` ${detail.slice(0, 200)}` : ""}`, response.status);
  }
  return response;
}

async function githubFetch(
  config: GitHubConfig,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await githubRequest(config, path, init);
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

/** The next-page URL from a GitHub `Link` header, or null at the last page. */
function nextPageUrl(response: Response): string | null {
  const link = response.headers.get("link");
  if (!link) return null;
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

/** Fetch every page of a list endpoint, following `Link: rel="next"` (capped). */
async function githubFetchAll<T>(config: GitHubConfig, firstPath: string): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let url: string | null = firstPath;
  let pages = 0;
  while (url && pages < MAX_PAGES) {
    const response: Response = await githubRequest(config, url);
    const page = (await response.json()) as T[];
    items.push(...page);
    url = nextPageUrl(response);
    pages += 1;
  }
  return { items, truncated: Boolean(url) };
}

/** Confirm the token can see the repo (used by the "Test connection" button). */
export async function verifyRepo(config: GitHubConfig): Promise<{ fullName: string; private: boolean }> {
  const { owner, name } = parseRepo(config.repo);
  const data = (await githubFetch(config, `/repos/${owner}/${name}`)) as {
    full_name: string;
    private: boolean;
  };
  return { fullName: data.full_name, private: data.private };
}

function markerless(body: string): string {
  return body.replace(STACKS_MARKER, "").trimEnd();
}

/**
 * List open issues (excluding pull requests), following all pages. When `since`
 * is given, sorts by `updated` and returns only issues touched since then —
 * any edit (rename, new/edited comment) bumps updated_at, so this is the
 * incremental change-gate. `truncated` is true if the page cap was hit.
 */
export async function listOpenIssues(config: GitHubConfig, since?: string): Promise<{ issues: GitHubIssue[]; truncated: boolean }> {
  const { owner, name } = parseRepo(config.repo);
  const query = since
    ? `state=open&per_page=100&sort=updated&direction=asc&since=${encodeURIComponent(since)}`
    : "state=open&per_page=100&sort=created&direction=asc";
  const { items, truncated } = await githubFetchAll<{ number: number; title: string; body: string | null; state: string; updated_at: string; pull_request?: unknown }>(
    config,
    `/repos/${owner}/${name}/issues?${query}`,
  );
  return {
    issues: items.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: markerless(issue.body ?? ""),
      state: issue.state,
      updatedAt: issue.updated_at,
      isPullRequest: Boolean(issue.pull_request),
    })),
    truncated,
  };
}

/** List every comment on an issue (all pages), oldest first. */
export async function listComments(config: GitHubConfig, issueNumber: number): Promise<GitHubComment[]> {
  const { owner, name } = parseRepo(config.repo);
  const { items } = await githubFetchAll<{ id: number; body: string | null; updated_at: string }>(
    config,
    `/repos/${owner}/${name}/issues/${issueNumber}/comments?per_page=100`,
  );
  return items.map((comment) => ({
    id: comment.id,
    body: markerless(comment.body ?? ""),
    updatedAt: comment.updated_at,
    fromStacks: (comment.body ?? "").includes(STACKS_MARKER),
  }));
}

/** Rename an issue to match a locally-renamed feed (title push, local wins). */
export async function patchIssueTitle(config: GitHubConfig, issueNumber: number, title: string): Promise<void> {
  const { owner, name } = parseRepo(config.repo);
  await githubFetch(config, `/repos/${owner}/${name}/issues/${issueNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ title: title.slice(0, 250) || "Untitled feed" }),
  });
}

/** Close or reopen a feed's issue, mirroring a collapsed/expanded feed. */
export async function patchIssueState(config: GitHubConfig, issueNumber: number, state: "open" | "closed"): Promise<void> {
  const { owner, name } = parseRepo(config.repo);
  await githubFetch(config, `/repos/${owner}/${name}/issues/${issueNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ state }),
  });
}

/** Open a new issue for a feed. Returns the created issue number. */
export async function createIssue(
  config: GitHubConfig,
  input: { title: string; body: string },
): Promise<number> {
  const { owner, name } = parseRepo(config.repo);
  const data = (await githubFetch(config, `/repos/${owner}/${name}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: input.title.slice(0, 250) || "Untitled feed",
      body: `${STACKS_MARKER}\n${input.body}`.slice(0, 60000),
    }),
  })) as { number: number };
  return data.number;
}

/**
 * Upload an attachment file into the repo via the Contents API (GitHub has no
 * issue-attachment REST endpoint), so a mobile reader can download it from the
 * private repo. Idempotent: if the path already holds identical bytes it's left
 * alone. Returns the repo blob URL to link in the mirrored comment.
 */
export async function uploadAttachment(
  config: GitHubConfig,
  repoPath: string,
  bytes: Buffer,
): Promise<string> {
  const { owner, name } = parseRepo(config.repo);
  const encodedPath = repoPath.split("/").map(encodeURIComponent).join("/");
  const contentsUrl = `/repos/${owner}/${name}/contents/${encodedPath}`;
  // Look up an existing file's sha (required to update, and lets us skip a
  // no-op re-upload of the same content).
  let existingSha: string | undefined;
  try {
    const existing = (await githubFetch(config, contentsUrl)) as { sha?: string; content?: string } | null;
    if (existing?.sha) {
      existingSha = existing.sha;
      const remoteB64 = (existing.content ?? "").replace(/\n/g, "");
      if (remoteB64 && remoteB64 === bytes.toString("base64")) {
        return `https://github.com/${owner}/${name}/blob/HEAD/${encodedPath}`;
      }
    }
  } catch {
    // 404 (not yet uploaded) is expected; fall through to create it.
  }
  const data = (await githubFetch(config, contentsUrl, {
    method: "PUT",
    body: JSON.stringify({
      message: `stacks: attachment ${repoPath}`,
      content: bytes.toString("base64"),
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  })) as { content?: { html_url?: string } };
  return data.content?.html_url ?? `https://github.com/${owner}/${name}/blob/HEAD/${encodedPath}`;
}

/** Post a Stacks-authored comment (marked so sync skips it on ingest). */
export async function postComment(
  config: GitHubConfig,
  issueNumber: number,
  body: string,
): Promise<number> {
  const { owner, name } = parseRepo(config.repo);
  const data = (await githubFetch(config, `/repos/${owner}/${name}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: `${STACKS_MARKER}\n${body}`.slice(0, 60000) }),
  })) as { id: number };
  return data.id;
}

/** Read a single comment's raw body (used to backfill without clobbering it). */
export async function getCommentBody(config: GitHubConfig, commentId: number): Promise<string | null> {
  const { owner, name } = parseRepo(config.repo);
  try {
    const data = (await githubFetch(config, `/repos/${owner}/${name}/issues/comments/${commentId}`)) as { body?: string };
    return data.body ?? "";
  } catch {
    return null; // Deleted upstream; caller skips it.
  }
}

/** Replace a Stacks-authored comment's body (keeps the agent marker). */
export async function editComment(config: GitHubConfig, commentId: number, body: string): Promise<void> {
  const { owner, name } = parseRepo(config.repo);
  const marked = body.includes(STACKS_MARKER) ? body : `${STACKS_MARKER}\n${body}`;
  await githubFetch(config, `/repos/${owner}/${name}/issues/comments/${commentId}`, {
    method: "PATCH",
    body: JSON.stringify({ body: marked.slice(0, 60000) }),
  });
}
