/**
 * Interrupt-then-send: a message typed while a turn is running stops that turn.
 * The stopped turn never replied, so the turn that replaces it has to answer the
 * request it cut off as well. Without that the earlier message gets no reply at
 * all: the thread shows the question, its tool calls, and then nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildFollowUpPrompt, buildForkPrompt } from "../../app/lib/feed-prompt.ts";

test("a follow-up that interrupted a turn asks for that request too", () => {
  const prompt = buildFollowUpPrompt({ reply: "and what about the healthcheck?", interrupted: true });
  assert.match(prompt, /stopped\s+that turn before you replied to it/);
  assert.match(prompt, /Answer that request as well, and answer it first/);
  // The interrupting message still has to read as the current one.
  assert.ok(prompt.includes("and what about the healthcheck?"));
  assert.ok(prompt.lastIndexOf("and what about the healthcheck?") > prompt.indexOf("answer it first"));
});

test("an ordinary follow-up says nothing about an interruption", () => {
  const prompt = buildFollowUpPrompt({ reply: "and what about the healthcheck?" });
  assert.doesNotMatch(prompt, /interrupt|before you replied/i);
});

test("a fork carries the same rule, and only when it interrupted a turn", () => {
  const transcript = "User: explain the dockerfile\n\nAssistant: it builds the task image";
  const interruptedFork = buildForkPrompt({ reply: "and the healthcheck?", transcript, interrupted: true });
  assert.match(interruptedFork, /stopped\s+that turn before you replied to it/);
  // The rule precedes the new message, which still introduces itself as the
  // continuation, so the two requests stay in order.
  assert.ok(interruptedFork.indexOf("answer it first") < interruptedFork.indexOf("The user now continues"));
  assert.ok(interruptedFork.includes(transcript));

  const plainFork = buildForkPrompt({ reply: "and the healthcheck?", transcript });
  assert.doesNotMatch(plainFork, /interrupt|before you replied/i);
  assert.match(plainFork, /The user now continues the conversation:\nand the healthcheck\?/);
});
