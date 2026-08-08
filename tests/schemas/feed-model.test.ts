import assert from "node:assert/strict";
import test from "node:test";

import { feedAgentModel } from "../../app/lib/feed-model.ts";

test("new feeds use the Claude model saved in Settings", () => {
  assert.equal(feedAgentModel(null, "us.anthropic.claude-opus-5"), "us.anthropic.claude-opus-5");
});

test("an existing feed keeps its explicit model override", () => {
  assert.equal(
    feedAgentModel("us.anthropic.claude-sonnet-5", "us.anthropic.claude-opus-5"),
    "us.anthropic.claude-sonnet-5",
  );
});

test("an incompatible global model is left to Claude Code", () => {
  assert.equal(feedAgentModel(null, "openai.gpt-5.6-sol"), "");
});
