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
  /** GitHub marks issues that are actually PRs; we skip those. */
  isPullRequest: boolean;
}

export interface GitHubComment {
  id: number;
  body: string;
  /** True when the body carries the Stacks agent marker (i.e. we posted it). */
  fromStacks: boolean;
}

export class GitHubError extends Error {}

function parseRepo(repo: string): { owner: string; name: string } {
  const match = repo.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) {
    throw new GitHubError('Set the GitHub repo as "owner/name" (e.g. octocat/stacks-inbox).');
  }
  return { owner: match[1], name: match[2] };
}

async function githubFetch(
  config: GitHubConfig,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...init.headers,
    },
    // Never follow a redirect off api.github.com.
    redirect: "error",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const hint = response.status === 401 || response.status === 403
      ? " Check the token has issues:write on this repo."
      : response.status === 404
        ? " Check the repo exists and the token can see it."
        : "";
    throw new GitHubError(`GitHub API ${response.status}.${hint}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
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

/** List open issues (excluding pull requests), newest first. */
export async function listOpenIssues(config: GitHubConfig): Promise<GitHubIssue[]> {
  const { owner, name } = parseRepo(config.repo);
  const data = (await githubFetch(
    config,
    `/repos/${owner}/${name}/issues?state=open&per_page=100&sort=created&direction=desc`,
  )) as Array<{ number: number; title: string; body: string | null; state: string; pull_request?: unknown }>;
  return data.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: markerless(issue.body ?? ""),
    state: issue.state,
    isPullRequest: Boolean(issue.pull_request),
  }));
}

/** List every comment on an issue, oldest first. */
export async function listComments(config: GitHubConfig, issueNumber: number): Promise<GitHubComment[]> {
  const { owner, name } = parseRepo(config.repo);
  const data = (await githubFetch(
    config,
    `/repos/${owner}/${name}/issues/${issueNumber}/comments?per_page=100`,
  )) as Array<{ id: number; body: string | null }>;
  return data.map((comment) => ({
    id: comment.id,
    body: markerless(comment.body ?? ""),
    fromStacks: (comment.body ?? "").includes(STACKS_MARKER),
  }));
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
