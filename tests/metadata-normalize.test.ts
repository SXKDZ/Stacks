import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAuthorNames, normalizePages, normalizeTitle, normalizeAbstract } from "../app/lib/metadata-normalize.ts";

test("title-cases with acronym preservation and hyphen handling (papercli parity)", () => {
  const cases: Array<[string, string]> = [
    ["attention is all you need", "Attention Is All You Need"],
    ["BERT: pre-training of deep bidirectional transformers for language understanding", "BERT: Pre-Training of Deep Bidirectional Transformers for Language Understanding"],
    ["in-context learning and induction heads", "In-Context Learning and Induction Heads"],
    ["on the opportunities and risks of foundation models", "On the Opportunities and Risks of Foundation Models"],
    ["GPT-4 technical report", "GPT-4 Technical Report"],
    ["a survey of LLM-based agents", "A Survey of LLM-Based Agents"],
    ["RoPE to nope and back again", "RoPE to Nope and Back Again"],
    ["learning to summarize from human feedback", "Learning to Summarize From Human Feedback"],
    ["XML and JSON parsing with ML models", "XML and JSON Parsing With ML Models"],
    ["end-to-end object detection", "End-To-End Object Detection"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeTitle(input), expected);
  }
});

test("reorders Last, First and splits multi-author strings without changing case", () => {
  const cases: Array<[string | string[], string[]]> = [
    ["Smith, John", ["John Smith"]],
    ["John Smith, Jane Doe", ["John Smith", "Jane Doe"]],
    ["Smith, John and Doe, Jane", ["John Smith", "Jane Doe"]],
    ["John Smith and Jane Doe", ["John Smith", "Jane Doe"]],
    ["Aaron Gokaslan, Achal Dave, Aditi Krishnapriyan", ["Aaron Gokaslan", "Achal Dave", "Aditi Krishnapriyan"]],
    ["van der Berg, Jan", ["Jan van der Berg"]],
    ["Smith, John Michael", ["John Michael Smith"]],
    ["Vaswani, Ashish and Shazeer, Noam", ["Ashish Vaswani", "Noam Shazeer"]],
    [["John Smith", " Jane Doe "], ["John Smith", "Jane Doe"]],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(normalizeAuthorNames(input), expected);
  }
});

test("collapses page dashes and rejoins broken abstract lines", () => {
  assert.equal(normalizePages("5998--6008"), "5998-6008");
  assert.equal(normalizePages("101–118"), "101-118");
  assert.equal(
    normalizeAbstract("The dominant sequence\ntransduction models are\nbased on complex RNNs."),
    "The dominant sequence transduction models are based on complex RNNs.",
  );
});
