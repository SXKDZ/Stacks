import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { formatAgentFailure } from "../../app/lib/agent-error.ts";
import { coalesceLegacyAgentErrors, splitFeedError } from "../../app/lib/feed-errors.ts";
import { effectiveFeedStatus } from "../../app/lib/feed-status.ts";

test("an agent failure preserves its structured result, stderr, and process exit", () => {
  const message = formatAgentFailure({
    resultEvent: {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      error: { message: "Bedrock rejected the request" },
      permission_denials: [{ tool: "Bash", reason: "denied" }],
    },
    stderr: "provider diagnostic",
    code: 1,
    signal: null,
  });

  assert.match(message, /^Agent turn failed\./);
  assert.match(message, /error_during_execution/);
  assert.match(message, /Bedrock rejected the request/);
  assert.match(message, /provider diagnostic/);
  assert.match(message, /code: 1/);
});

test("max-turn failures explain how to resume", () => {
  const parts = splitFeedError(`Agent turn failed.\n\nAgent result event:\n${JSON.stringify({
    subtype: "error_max_turns",
    errors: ["Reached maximum number of turns (40)"],
  }, null, 2)}`);

  assert.equal(parts.summary, "This run reached its turn limit before finishing. Send “continue” to resume.");
  assert.match(parts.details, /error_max_turns/);
});

test("legacy result and exit rows render as one failure", () => {
  const messages = [
    { id: "reported", kind: "error", content: "The agent reported an error.", createdAt: "2026-08-09T06:31:19.259Z" },
    { id: "exit", kind: "error", content: "The agent exited with code 1.", createdAt: "2026-08-09T06:31:19.272Z" },
  ];

  const coalesced = coalesceLegacyAgentErrors(messages);
  assert.equal(coalesced.length, 1);
  assert.deepEqual(splitFeedError(coalesced[0].content), {
    summary: "Agent turn failed.",
    details: "Process exit:\ncode: 1",
  });
});

test("separate failures are not coalesced", () => {
  const messages = [
    { id: "first", kind: "error", content: "The agent reported an error.", createdAt: "2026-08-09T06:31:19.000Z" },
    { id: "second", kind: "error", content: "The agent exited with code 1.", createdAt: "2026-08-09T06:31:21.000Z" },
  ];

  assert.equal(coalesceLegacyAgentErrors(messages).length, 2);
});

test("the result handler defers persistence to the single terminal failure path", async () => {
  const source = await readFile(new URL("../../app/lib/feed-agent.ts", import.meta.url), "utf8");
  const resultHandler = source.slice(source.indexOf('if (event.type === "result")'), source.indexOf('child.stdout?.on("data"'));

  assert.match(resultHandler, /failedResultEvent = event/);
  assert.doesNotMatch(resultHandler, /persistMessage\(snippetId, "system", "error"/);
  assert.match(source, /const finishError = async/);
  assert.match(source, /formatAgentFailure\(\{ resultEvent, stderr, processError, code, signal \}\)/);
});

test("stream events finish saving in order before terminal status", async () => {
  const source = await readFile(new URL("../../app/lib/feed-agent.ts", import.meta.url), "utf8");

  assert.match(source, /__stacksFeedRuntimeV1/);
  assert.match(source, /launching\.add\(snippetId\)/);
  assert.match(source, /eventQueue = eventQueue\s*\.then\(\(\) => handleLine\(line\)\)/s);
  assert.match(source, /await eventQueue/);
  assert.doesNotMatch(source, /void handleLine\(line\)/);
});

test("technical details use the full diagnostic width", async () => {
  const component = await readFile(new URL("../../app/components/FeedWorkspace.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../app/styles/workspaces.css", import.meta.url), "utf8");

  assert.match(component, /<span>Technical details<\/span>/);
  assert.match(styles, /\.feed-error-content\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.match(styles, /\.feed-error-details pre\s*\{[^}]*width:\s*100%/s);
  assert.match(styles, /\.feed-error-details pre\s*\{[^}]*max-height:\s*min\(32vh,\s*260px\)/s);
});

test("list markers in user messages inherit the bubble text color", async () => {
  const styles = await readFile(new URL("../../app/styles/workspaces.css", import.meta.url), "utf8");

  assert.match(styles, /\.feed-turn-user \.feed-bubble li::marker\s*\{[^}]*color:\s*currentColor/s);
});

test("a stale Done state is presented as an actionable incomplete run", () => {
  const snippet = {
    status: "done",
    error: null,
    updatedAt: "2026-08-09T06:56:22.803Z",
  };

  const effective = effectiveFeedStatus(snippet, "2026-08-09T07:00:50.932Z", false);
  assert.equal(effective.status, "error");
  assert.match(effective.error ?? "", /Send a follow-up message to continue/);
});

test("a live process wins over a stale stored terminal state", () => {
  const effective = effectiveFeedStatus(
    { status: "done", error: null, updatedAt: "2026-08-09T06:56:22.803Z" },
    "2026-08-09T07:00:50.932Z",
    true,
  );
  assert.equal(effective.status, "running");
  assert.equal(effective.error, null);
});

test("a clean terminal state remains Done", () => {
  const snippet = {
    status: "done",
    error: null,
    updatedAt: "2026-08-09T07:00:50.932Z",
  };

  assert.equal(effectiveFeedStatus(snippet, "2026-08-09T07:00:50.900Z", false), snippet);
});
