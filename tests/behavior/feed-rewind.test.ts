/**
 * Cutting a feed thread short, against a real database: the rewind route end to end,
 * and the truncation a retry performs (its route then relaunches the agent, which a
 * test must not do, so that half is asserted on the shared function it calls).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { jsonRequest, readJson, createTempLibrary } from "../support/harness.ts";

// Must happen before any db module is imported (library-paths resolves the root
// once per process, and bootstrap caches its init promise).
createTempLibrary("stacks-feed-rewind");

const routeModule = import("../../app/api/feed/snippets/[id]/rewind/route.ts");
const context = (id: string) => ({ params: Promise.resolve({ id }) });

interface Row {
  id: string;
  role: string;
  kind: string;
  content: string;
}

async function seedFeed(id: string, options: { issueNumber?: number } = {}): Promise<{
  turns: string[];
  read: () => Promise<{ messages: Row[]; snippet: Record<string, unknown>; proposals: number }>;
}> {
  const { ensureDatabase } = await import("../../db/bootstrap.ts");
  const { feedMessages, feedProposals, feedSnippets } = await import("../../db/schema.ts");
  const { asc, eq } = await import("drizzle-orm");
  const database = await ensureDatabase();

  database.insert(feedSnippets).values({
    id,
    title: "Harness questions",
    instruction: "explain the dockerfile",
    status: "done",
    sessionId: "session-1",
    issueNumber: options.issueNumber ?? null,
    inputTokens: 900,
    outputTokens: 300,
    durationMs: 5000,
    turns: 2,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:10.000Z",
  }).run();

  // One complete turn, then a second the rewind will take back. Usage sits on the
  // message that concluded each turn, exactly as the agent records it.
  const rows = [
    { id: `${id}-a1`, role: "assistant", kind: "result", content: "It builds the task image.", at: "2026-08-31T00:00:01.000Z", inputTokens: 400, outputTokens: 100, durationMs: 2000 },
    { id: `${id}-u2`, role: "user", kind: "text", content: "and the healthcheck?", at: "2026-08-31T00:00:02.000Z", inputTokens: 0, outputTokens: 0, durationMs: 0 },
    { id: `${id}-t2`, role: "assistant", kind: "tool_use", content: "Read {}", at: "2026-08-31T00:00:03.000Z", inputTokens: 0, outputTokens: 0, durationMs: 0 },
    { id: `${id}-a2`, role: "assistant", kind: "result", content: "It curls the endpoint.", at: "2026-08-31T00:00:04.000Z", inputTokens: 500, outputTokens: 200, durationMs: 3000 },
  ];
  for (const row of rows) {
    database.insert(feedMessages).values({
      id: row.id,
      snippetId: id,
      role: row.role,
      kind: row.kind,
      content: row.content,
      githubCommentId: options.issueNumber ? 5000 + rows.indexOf(row) : null,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      durationMs: row.durationMs,
      createdAt: row.at,
    }).run();
  }
  // Two proposals: one from the turn being kept, one from the turn being removed.
  database.insert(feedProposals).values({
    id: `${id}-prop-keep`,
    snippetId: id,
    messageId: `${id}-a1`,
    operation: JSON.stringify({ entity: "paper", action: "create", summary: "add the paper" }),
    status: "applied",
    createdAt: "2026-08-31T00:00:01.500Z",
  }).run();
  database.insert(feedProposals).values({
    id: `${id}-prop-drop`,
    snippetId: id,
    messageId: `${id}-a2`,
    operation: JSON.stringify({ entity: "paper", action: "delete", id: "paper-1", summary: "drop the paper" }),
    status: "pending",
    githubCommentId: options.issueNumber ? 6000 : null,
    createdAt: "2026-08-31T00:00:04.500Z",
  }).run();

  return {
    turns: rows.map((row) => row.id),
    read: async () => ({
      messages: database.select().from(feedMessages).where(eq(feedMessages.snippetId, id)).orderBy(asc(feedMessages.createdAt)).all() as Row[],
      snippet: database.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get() as unknown as Record<string, unknown>,
      proposals: database.select().from(feedProposals).where(eq(feedProposals.snippetId, id)).all().length,
    }),
  };
}

async function rewind(id: string, interactionId: string) {
  const { POST } = await routeModule;
  return readJson(await POST(jsonRequest(`http://127.0.0.1/api/feed/snippets/${id}/rewind`, { interactionId }), context(id)));
}

test("a rewind removes the chosen turn and everything after it", async () => {
  const feed = await seedFeed("feed-rewind-1");

  const result = await rewind("feed-rewind-1", "feed-rewind-1-u2");

  assert.equal(result.status, 200);
  // The message it rewound to comes back so the composer can offer it for editing.
  assert.deepEqual(result.body, { removed: 3, reply: "and the healthcheck?" });

  const { messages, snippet, proposals } = await feed.read();
  assert.deepEqual(messages.map((message) => message.id), ["feed-rewind-1-a1"]);
  // The session is dropped, so the next reply rebuilds one from what is left
  // instead of resuming a transcript that still holds the removed turns.
  assert.equal(snippet.sessionId, "");
  assert.equal(snippet.status, "done");
  // The removed turn's usage leaves the feed's totals with it.
  assert.equal(snippet.inputTokens, 400);
  assert.equal(snippet.outputTokens, 100);
  assert.equal(snippet.durationMs, 2000);
  assert.equal(snippet.turns, 1);
  // The pending proposal from the removed turn cannot be approved any more; the
  // applied one from the surviving turn is untouched.
  assert.equal(proposals, 1);
});

test("a rewind only accepts a real interaction boundary", async () => {
  const feed = await seedFeed("feed-rewind-2");

  // An assistant message is not where an interaction starts, so it is not a point
  // the thread can be rewound to: the boundaries are the ones the selection UI
  // shows, not every row in the table.
  const assistant = await rewind("feed-rewind-2", "feed-rewind-2-a2");
  assert.equal(assistant.status, 404);
  assert.match(String(assistant.body.error), /not part of this feed/);

  const missing = await rewind("feed-rewind-2", "feed-rewind-2-nope");
  assert.equal(missing.status, 404);

  const otherFeed = await rewind("feed-missing", "feed-missing-u2");
  assert.equal(otherFeed.status, 404);

  // Nothing was removed by any of the three refusals.
  const { messages } = await feed.read();
  assert.equal(messages.length, 4);
});

test("rewinding to the opening interaction clears the replies and keeps the question", async () => {
  const feed = await seedFeed("feed-rewind-4");

  const result = await rewind("feed-rewind-4", "opening");

  assert.equal(result.status, 200);
  // Nothing returns to the composer: the instruction is still the thread's opening
  // turn, so handing back a copy of it would only duplicate the question.
  assert.deepEqual(result.body, { removed: 4, reply: "" });
  const { messages, snippet, proposals } = await feed.read();
  assert.equal(messages.length, 0);
  assert.equal(snippet.instruction, "explain the dockerfile");
  assert.equal(snippet.turns, 0);
  assert.equal(proposals, 0);
});

test("a retry keeps the turn's own message and removes only what it produced", async () => {
  const feed = await seedFeed("feed-retry-1");
  const { truncateFeedAt } = await import("../../app/lib/feed-truncate.ts");
  const { ensureDatabase } = await import("../../db/bootstrap.ts");
  const { feedSnippets } = await import("../../db/schema.ts");
  const { eq } = await import("drizzle-orm");
  const database = await ensureDatabase();
  const snippet = database.select().from(feedSnippets).where(eq(feedSnippets.id, "feed-retry-1")).get()!;

  const truncation = await truncateFeedAt(snippet, "feed-retry-1-u2", { keepStarter: true });

  assert.ok(truncation);
  // The question stays; its tool call and its answer go, so the retry asks the same
  // thing again instead of the user retyping it.
  assert.deepEqual(truncation.removed.map((message) => message.id), ["feed-retry-1-t2", "feed-retry-1-a2"]);
  const { messages, snippet: after, proposals } = await feed.read();
  assert.deepEqual(messages.map((message) => message.id), ["feed-retry-1-a1", "feed-retry-1-u2"]);
  assert.equal(after.sessionId, "");
  // Only the removed turn's usage leaves the totals.
  assert.equal(after.outputTokens, 100);
  assert.equal(proposals, 1);
  // What the fresh session is seeded with excludes the turn being retried, which the
  // route passes as the prompt instead.
  assert.deepEqual(truncation.kept.map((message) => message.id), ["feed-retry-1-a1", "feed-retry-1-u2"]);
});

test("a fork leaves a pending proposal behind", async () => {
  const feed = await seedFeed("feed-fork-1");
  const { POST } = await import("../../app/api/feed/snippets/[id]/fork/route.ts");
  const { ensureDatabase } = await import("../../db/bootstrap.ts");
  const { feedProposals } = await import("../../db/schema.ts");
  const { eq } = await import("drizzle-orm");
  const database = await ensureDatabase();

  const forked = await readJson<{ id: string }>(await POST(
    jsonRequest("http://127.0.0.1/api/feed/snippets/feed-fork-1/fork", {}),
    context("feed-fork-1"),
  ));

  assert.equal(forked.status, 200);
  // The applied one is history worth copying; the pending one is a library change
  // still awaiting approval, and copied it would be queued twice, offered in two
  // threads and mirrored under two issues.
  const copied = database.select().from(feedProposals).where(eq(feedProposals.snippetId, forked.body.id)).all();
  assert.deepEqual(copied.map((proposal) => proposal.status), ["applied"]);
  // The source keeps both.
  assert.equal(database.select().from(feedProposals).where(eq(feedProposals.snippetId, "feed-fork-1")).all().length, 2);
  void feed;
});

test("cutting a mirrored thread retires its comments and keeps the issue", async () => {
  // The outbox and the retired-comment record both key on the configured repo, so
  // neither fires for a library with no GitHub sync set up.
  process.env.STACKS_GITHUB_REPO = "SXKDZ/stacks-test";
  const feed = await seedFeed("feed-rewind-5", { issueNumber: 77 });
  const { truncateFeedAt } = await import("../../app/lib/feed-truncate.ts");
  const { ensureDatabase } = await import("../../db/bootstrap.ts");
  const { feedGithubOutbox, feedGithubRetiredComments, feedSnippets, feedMessages } = await import("../../db/schema.ts");
  const { eq } = await import("drizzle-orm");
  const database = await ensureDatabase();
  const snippet = database.select().from(feedSnippets).where(eq(feedSnippets.id, "feed-rewind-5")).get()!;

  await truncateFeedAt(snippet, "feed-rewind-5-u2", { keepStarter: false });

  // The issue keeps its link: unlinking left an issue no feed claimed, which the next
  // inbound pass adopted as a feed of its own and ran an agent on.
  const { snippet: after, messages } = await feed.read();
  assert.equal(after.issueNumber, 77);
  // The removed messages' comments stay on the issue as a record, but are retired so
  // the inbound pass never reads them as new.
  const retired = database.select().from(feedGithubRetiredComments).all();
  assert.deepEqual(retired.map((row) => row.commentId).sort(), [5001, 5002, 5003]);
  // What survived keeps its comment id, so nothing is mirrored a second time.
  const kept = messages.find((message) => message.id === "feed-rewind-5-a1");
  assert.equal((kept as unknown as { githubCommentId: number | null }).githubCommentId, 5000);
  // The dropped proposal's comment stops offering a change nobody can approve.
  const queued = database.select().from(feedGithubOutbox).where(eq(feedGithubOutbox.op, "edit-comment")).all();
  assert.equal(queued.length, 1);
  assert.match(String(queued[0].body), /Removed from the thread/);
  assert.ok(messages.some((message) => message.role === "system" && /no longer read/.test(message.content)));
  void feedMessages;
  delete process.env.STACKS_GITHUB_REPO;
});
