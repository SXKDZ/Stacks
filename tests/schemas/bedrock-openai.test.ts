import assert from "node:assert/strict";
import test from "node:test";

import { invokeBedrockMessages, isOpenAIResponsesModel } from "../../app/lib/bedrock.ts";
import { OpenAIResponsesResponseSchema, openAIResponseText } from "../../app/lib/schemas/bedrock.ts";

test("routes frontier OpenAI IDs to Responses without capturing Runtime IDs", () => {
  assert.equal(isOpenAIResponsesModel("openai.gpt-5.6-sol"), true);
  assert.equal(isOpenAIResponsesModel("openai.gpt-5.6-terra"), true);
  assert.equal(isOpenAIResponsesModel("openai.gpt-oss-20b-1:0"), false);
  assert.equal(isOpenAIResponsesModel("us.anthropic.claude-sonnet-5"), false);
});

test("extracts final answer text from a Responses API payload", () => {
  const payload = OpenAIResponsesResponseSchema.parse({
    id: "resp_123",
    output: [
      { type: "reasoning", summary: [] },
      {
        type: "message",
        content: [
          { type: "output_text", text: "First paragraph." },
          { type: "output_text", text: "Second paragraph." },
        ],
      },
    ],
  });
  assert.equal(openAIResponseText(payload), "First paragraph.\nSecond paragraph.");
  assert.equal(openAIResponseText(OpenAIResponsesResponseSchema.parse({ output_text: "Fallback" })), "Fallback");
});

test("sends GPT-5.6 through Bedrock Mantle with supported-region and privacy defaults", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await invokeBedrockMessages({
      token: "test-token",
      region: "eu-west-1",
      model: "openai.gpt-5.6-sol",
      system: "System guidance",
      messages: [{ role: "user", content: "Hello" }],
      maxTokens: 256,
      effort: "high",
    });

    assert.equal(requestUrl, "https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses");
    assert.deepEqual(requestBody, {
      model: "openai.gpt-5.6-sol",
      instructions: "System guidance",
      input: [{ role: "user", content: "Hello" }],
      max_output_tokens: 256,
      store: false,
      reasoning: { effort: "high" },
    });
    // `truncated` reports a reply that stopped at the max-tokens ceiling, so a
    // caller cannot present a cut-off answer as a finished one.
    assert.deepEqual(result, { content: "OK", endpoint: "mantle", region: "us-east-1", truncated: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
