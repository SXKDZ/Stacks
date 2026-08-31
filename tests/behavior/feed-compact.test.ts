/**
 * Compacting a feed's agent session. The compaction itself is a `claude -p
 * "/compact"` subprocess, which a test must not run, so what is exercised here are
 * the states that answer without spawning anything: a thread with no session, and a
 * thread whose agent is mid-turn.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readJson, createTempLibrary } from "../support/harness.ts";

createTempLibrary("stacks-feed-compact");

const routeModule = import("../../app/api/feed/snippets/[id]/compact/route.ts");
const context = (id: string) => ({ params: Promise.resolve({ id }) });

async function seed(id: string, sessionId: string | null): Promise<void> {
  const { ensureDatabase } = await import("../../db/bootstrap.ts");
  const { feedSnippets } = await import("../../db/schema.ts");
  const database = await ensureDatabase();
  database.insert(feedSnippets).values({
    id,
    title: "Long thread",
    instruction: "explain the dockerfile",
    status: "done",
    sessionId,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:01.000Z",
  }).run();
}

async function compact(id: string) {
  const { POST } = await routeModule;
  return readJson(await POST(new Request(`http://127.0.0.1/api/feed/snippets/${id}/compact`, { method: "POST" }), context(id)));
}

test("a thread with no agent session has nothing to compact", async () => {
  await seed("feed-compact-1", "");

  const result = await compact("feed-compact-1");

  // A state the user can act on, not a server fault.
  assert.equal(result.status, 409);
  assert.match(String(result.body.error), /no agent session yet/);
});

test("compacting an unknown feed is a 404", async () => {
  const result = await compact("feed-compact-missing");
  assert.equal(result.status, 404);
});

test("the thread's own messages are never touched by a compaction", async () => {
  await seed("feed-compact-2", null);
  const { ensureDatabase } = await import("../../db/bootstrap.ts");
  const { feedMessages } = await import("../../db/schema.ts");
  const { eq } = await import("drizzle-orm");
  const database = await ensureDatabase();
  database.insert(feedMessages).values({
    id: "feed-compact-2-a1",
    snippetId: "feed-compact-2",
    role: "assistant",
    kind: "result",
    content: "It builds the task image.",
    createdAt: "2026-08-31T00:00:02.000Z",
  }).run();

  await compact("feed-compact-2");

  // Compaction shortens what the agent carries between turns; the conversation the
  // user reads is stored separately and stays whole. That is the whole difference
  // from a rewind.
  const messages = database.select().from(feedMessages).where(eq(feedMessages.snippetId, "feed-compact-2")).all();
  assert.deepEqual(messages.map((message) => message.id), ["feed-compact-2-a1"]);
});
