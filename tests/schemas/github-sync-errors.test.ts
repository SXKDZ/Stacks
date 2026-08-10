import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createGitHubSyncPolicy,
  GitHubError,
  GitHubSyncDeferred,
  postComment,
  verifyRepo,
} from "../../app/lib/github-sync";
import { readErrorInfo } from "../../app/lib/http";

test("GitHub failures retain safe request diagnostics without exposing the token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret-token");
    return new Response(JSON.stringify({
      message: "Resource not accessible by personal access token",
      documentation_url: "https://docs.github.com/rest/issues/issues#create-an-issue",
    }), {
      status: 403,
      statusText: "Forbidden",
      headers: {
        "x-github-request-id": "REQ-123",
        "x-ratelimit-remaining": "4999",
      },
    });
  };

  try {
    await assert.rejects(
      verifyRepo({ repo: "owner/inbox", token: "secret-token" }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubError);
        assert.equal(error.status, 403);
        assert.match(error.message, /Issues read\/write permission/);
        assert.match(error.details, /Request: GET \/repos\/owner\/inbox/);
        assert.match(error.details, /Status: 403 Forbidden/);
        assert.match(error.details, /GitHub request ID: REQ-123/);
        assert.match(error.details, /Resource not accessible by personal access token/);
        assert.doesNotMatch(error.details, /secret-token/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("secondary rate limits are identified and their complete message is retained", async () => {
  const originalFetch = globalThis.fetch;
  const githubMessage = `You have exceeded a secondary rate limit and have been temporarily blocked from content creation. ${"detail ".repeat(1_500)}COMPLETE-END`;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: githubMessage }), {
    status: 403,
    statusText: "Forbidden",
    headers: { "retry-after": "60", "x-ratelimit-remaining": "4999" },
  });

  try {
    await assert.rejects(
      verifyRepo({ repo: "owner/inbox", token: "secret-token" }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubError);
        assert.match(error.message, /too many write requests/);
        assert.match(error.details, /Retry after: 60 seconds/);
        assert.match(error.details, /COMPLETE-END/);
        assert.doesNotMatch(error.details, /secret-token/);
        assert.equal(error.retryAfterMs, 60_000);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub 429 responses carry their retry window", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: "You have exceeded a secondary rate limit.",
  }), {
    status: 429,
    statusText: "Too Many Requests",
    headers: { "retry-after": "5" },
  });

  try {
    await assert.rejects(
      verifyRepo({ repo: "owner/inbox", token: "secret-token" }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubError);
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterMs, 5_000);
        assert.match(error.message, /too many write requests/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a GitHub write batch stops before sending beyond its mutation budget", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({ id: 123 });
  };
  const syncPolicy = createGitHubSyncPolicy(1);
  const config = { repo: "owner/inbox", token: "secret-token", syncPolicy };

  try {
    assert.equal(await postComment(config, 7, "first"), 123);
    await assert.rejects(
      postComment(config, 7, "second"),
      (error: unknown) => {
        assert.ok(error instanceof GitHubSyncDeferred);
        assert.equal(error.reason, "batch");
        return true;
      },
    );
    assert.equal(requests, 1);
    assert.equal(syncPolicy.mutations, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP error reader keeps summary and technical details separate", async () => {
  const response = Response.json({
    error: "GitHub denied access.",
    details: "Status: 403 Forbidden\nGitHub request ID: REQ-123",
  }, { status: 403 });

  assert.deepEqual(await readErrorInfo(response), {
    summary: "GitHub denied access.",
    details: "Status: 403 Forbidden\nGitHub request ID: REQ-123",
  });
});

test("feed sync failures have a persistent alert and expandable activity diagnostics", async () => {
  const [feed, styles] = await Promise.all([
    readFile(new URL("../../app/components/FeedWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/styles/data-interactions.css", import.meta.url), "utf8"),
  ]);

  assert.match(feed, /readErrorInfo\(response\)/);
  assert.match(feed, /recordSync\("error", failure\.summary, failure\.details\)/);
  assert.match(feed, /className="toast toast-error feed-sync-toast"/);
  assert.match(feed, /<details className="background-task-diagnostics">/);
  assert.match(feed, /Technical details/);
  assert.match(styles, /\.background-task-diagnostics summary:focus-visible/);
});
