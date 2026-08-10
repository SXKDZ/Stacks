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
  /** Optional per-pass write budget used by the resumable inbox bulk sync. */
  syncPolicy?: GitHubSyncPolicy;
}

/**
 * A sync pass is deliberately small enough to finish inside one HTTP request.
 * Each successful write is checkpointed in SQLite immediately, so the next pass
 * resumes at the first unsynced issue/comment instead of repeating prior work.
 */
export interface GitHubSyncPolicy {
  maxMutations: number;
  mutations: number;
}

export function createGitHubSyncPolicy(maxMutations = 20): GitHubSyncPolicy {
  return { maxMutations, mutations: 0 };
}

/** Internal, expected pause: the current pass is full or the local hourly
 * safety budget is exhausted. The sync route turns this into a resumable 200
 * response rather than presenting it as a failed GitHub request. */
export class GitHubSyncDeferred extends Error {
  readonly reason: "batch" | "cooldown";
  readonly retryAfterMs: number;
  constructor(reason: "batch" | "cooldown", retryAfterMs: number) {
    super(reason === "batch" ? "The current GitHub write batch is complete." : "GitHub writes are cooling down.");
    this.name = "GitHubSyncDeferred";
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
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
  /** Safe diagnostic context that can be shown without exposing the token. */
  readonly details: string;
  /** How long GitHub told the caller to wait before another attempt. */
  readonly retryAfterMs: number;
  constructor(message: string, status = 0, details = "", retryAfterMs = 0) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
  }
}

interface GitHubApiErrorBody {
  message?: string;
  documentation_url?: string;
  errors?: unknown;
}

/** Turn GitHub's response into concise recovery copy plus safe diagnostics.
 * The access token is never part of either string. */
function githubFailure(
  response: Response,
  requestUrl: string,
  method: string,
  rawBody: string,
): { summary: string; details: string; retryAfterMs: number } {
  let body: GitHubApiErrorBody = {};
  try {
    body = JSON.parse(rawBody) as GitHubApiErrorBody;
  } catch {
    // Non-JSON gateway responses are retained verbatim in the detail block.
  }

  const githubMessage = typeof body.message === "string" ? body.message.trim() : "";
  const documentationUrl = typeof body.documentation_url === "string" ? body.documentation_url.trim() : "";
  const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
  const rateLimitReset = response.headers.get("x-ratelimit-reset");
  const retryAfter = response.headers.get("retry-after");
  const rateLimitStatus = response.status === 403 || response.status === 429;
  const primaryRateLimited = rateLimitStatus && rateLimitRemaining === "0";
  const secondaryRateLimited = rateLimitStatus && /secondary rate limit|temporarily blocked from content creation/i.test(githubMessage);
  let summary = `GitHub rejected the sync request (${response.status}).`;
  if (response.status === 401) {
    summary = "GitHub did not accept the access token. Update it in Settings and try again.";
  } else if (secondaryRateLimited) {
    summary = "GitHub temporarily blocked content creation because too many write requests were sent. Wait, then sync again.";
  } else if (primaryRateLimited) {
    summary = "GitHub's API rate limit has been reached. Try syncing again after it resets.";
  } else if (response.status === 403) {
    summary = "GitHub denied access. Check this token's repository access and Issues read/write permission.";
  } else if (response.status === 404) {
    summary = "GitHub could not find this repository. Check the repository name and token access.";
  }

  const endpoint = new URL(requestUrl);
  const responseDetail = body.errors !== undefined
    ? JSON.stringify(body.errors, null, 2)
    : !githubMessage && rawBody.trim() ? rawBody.trim() : "";
  const resetAt = rateLimitReset && /^\d+$/.test(rateLimitReset)
    ? new Date(Number(rateLimitReset) * 1_000).toLocaleString()
    : "";
  const retryAfterSeconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : 0;
  const resetDelayMs = rateLimitReset && /^\d+$/.test(rateLimitReset)
    ? Math.max(0, Number(rateLimitReset) * 1_000 - Date.now())
    : 0;
  // GitHub says to wait at least one minute for a secondary limit when neither
  // Retry-After nor the primary-limit reset header provides a deadline.
  const retryAfterMs = retryAfterSeconds > 0
    ? Math.ceil(retryAfterSeconds * 1_000)
    : primaryRateLimited && resetDelayMs > 0
      ? resetDelayMs
      : secondaryRateLimited ? 60_000 : 0;
  const details = [
    `Request: ${method} ${endpoint.pathname}${endpoint.search}`,
    `Status: ${response.status} ${response.statusText || "Unknown"}`,
    response.headers.get("x-github-request-id") ? `GitHub request ID: ${response.headers.get("x-github-request-id")}` : "",
    githubMessage ? `GitHub message: ${githubMessage}` : "",
    retryAfter ? `Retry after: ${retryAfter} seconds` : "",
    rateLimitRemaining !== null ? `Rate limit remaining: ${rateLimitRemaining}` : "",
    resetAt ? `Rate limit resets: ${resetAt}` : "",
    documentationUrl ? `Documentation: ${documentationUrl}` : "",
    responseDetail ? `Response details:\n${responseDetail}` : "",
  ].filter(Boolean).join("\n");

  return { summary, details, retryAfterMs };
}

function parseRepo(repo: string): { owner: string; name: string } {
  const match = repo.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) {
    throw new GitHubError('Set the GitHub repo as "owner/name" (e.g. octocat/stacks-inbox).');
  }
  const [, owner, name] = match;
  // `.` is a legal repo-name character, so ".." matched the pattern: the request
  // path became /repos/../../issues, and URL resolution collapses the dot segments,
  // aiming the call at a different API endpoint than the one this module pins.
  if ([owner, name].some((segment) => segment === "." || segment === "..")) {
    throw new GitHubError('Set the GitHub repo as "owner/name" (e.g. octocat/stacks-inbox).');
  }
  return { owner, name };
}

// A defensive ceiling on pages walked per list, so a runaway Link chain can't
// loop forever. 20 pages × 100/page = 2000 items, far above a personal inbox.
const MAX_PAGES = 20;

// GitHub explicitly recommends serial requests and at least one second between
// POST/PATCH/PUT/DELETE calls. A shared queue covers manual sync, the delete
// outbox, and any overlapping background write without relying on each caller
// to remember the rule.
const MIN_MUTATION_INTERVAL_MS = 1_000;
// GitHub's documented general content-creation ceiling is 500/hour. Keep local
// headroom for actions made in github.com and other clients using the same user.
const MAX_MUTATIONS_PER_HOUR = 400;
let mutationQueue: Promise<void> = Promise.resolve();
let lastMutationAt = 0;
const recentMutations: number[] = [];

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function queueMutation<T>(config: GitHubConfig, send: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(async () => {
    const policy = config.syncPolicy;
    if (policy && policy.mutations >= policy.maxMutations) {
      throw new GitHubSyncDeferred("batch", MIN_MUTATION_INTERVAL_MS);
    }

    const now = Date.now();
    while (recentMutations.length && recentMutations[0] <= now - 60 * 60 * 1_000) {
      recentMutations.shift();
    }
    if (recentMutations.length >= MAX_MUTATIONS_PER_HOUR) {
      throw new GitHubSyncDeferred(
        "cooldown",
        Math.max(MIN_MUTATION_INTERVAL_MS, recentMutations[0] + 60 * 60 * 1_000 - now),
      );
    }

    await wait(Math.max(0, lastMutationAt + MIN_MUTATION_INTERVAL_MS - Date.now()));
    const sentAt = Date.now();
    lastMutationAt = sentAt;
    recentMutations.push(sentAt);
    if (policy) policy.mutations += 1;
    return send();
  });
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

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
  const method = (init.method ?? "GET").toUpperCase();
  const send = () => fetch(url, {
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
  const response = ["POST", "PATCH", "PUT", "DELETE"].includes(method)
    ? await queueMutation(config, send)
    : await send();
  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    const failure = githubFailure(response, url, method, rawBody);
    throw new GitHubError(failure.summary, response.status, failure.details, failure.retryAfterMs);
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
 * List issues in every state (excluding pull requests), following all pages.
 * Closed issues are included so a remote close/reopen (from the phone) can be
 * adopted as the local collapsed state, and comments on closed issues still
 * sync. When `since` is given, sorts by `updated` and returns only issues
 * touched since then — any edit (rename, close, new/edited comment) bumps
 * updated_at, so this is the incremental change-gate. `truncated` is true if
 * the page cap was hit.
 */
export async function listIssues(config: GitHubConfig, since?: string): Promise<{ issues: GitHubIssue[]; truncated: boolean }> {
  const { owner, name } = parseRepo(config.repo);
  const query = since
    ? `state=all&per_page=100&sort=updated&direction=asc&since=${encodeURIComponent(since)}`
    : "state=all&per_page=100&sort=created&direction=asc";
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
  return (await listCommentsPaged(config, issueNumber)).comments;
}

/**
 * List an issue's comments, reporting whether the page cap cut the list short.
 *
 * `listComments` dropped the `truncated` flag, so a very long thread was silently
 * read as complete: the sync then advanced its high-water mark past comments it
 * had never seen, and they were never ingested.
 */
export async function listCommentsPaged(
  config: GitHubConfig,
  issueNumber: number,
): Promise<{ comments: GitHubComment[]; truncated: boolean }> {
  const { owner, name } = parseRepo(config.repo);
  const { items, truncated } = await githubFetchAll<{ id: number; body: string | null; updated_at: string }>(
    config,
    `/repos/${owner}/${name}/issues/${issueNumber}/comments?per_page=100`,
  );
  return { truncated, comments: items.map((comment) => ({
    id: comment.id,
    body: markerless(comment.body ?? ""),
    updatedAt: comment.updated_at,
    fromStacks: (comment.body ?? "").includes(STACKS_MARKER),
  })) };
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
