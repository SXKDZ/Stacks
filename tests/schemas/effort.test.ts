/**
 * Reasoning effort: the shared vocabulary between Bedrock and the `claude` CLI.
 *
 * The levels were read off the live services, not assumed. Bedrock's converse API
 * answers "unknown variant `bogus`, expected one of `low`, `medium`, `high`,
 * `xhigh`, `max`", and `claude --effort bogus` warns "Valid values: low, medium,
 * high, xhigh, max". They agree, which is why one module serves both.
 *
 * The failure that matters is sending a level a model rejects: Sonnet 4.5 and Haiku
 * 4.5 answer 400 "output_config.effort: Extra inputs are not permitted", so an
 * unset or unrecognised value has to omit the field entirely rather than pass
 * something through.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  bedrockEffortFields,
  claudeEffortArgs,
  EFFORT_LEVELS,
  effortLabel,
  effortSetting,
} from "../../app/lib/effort.ts";

test("the five levels are exactly what both providers accept", () => {
  assert.deepEqual([...EFFORT_LEVELS], ["low", "medium", "high", "xhigh", "max"]);
});

test("an unknown level is treated as unset rather than passed through", () => {
  // Bedrock 400s on an unrecognised variant, so a stray value must never reach it.
  for (const value of ["bogus", "turbo", "HIGHEST", "1", " ", "", null, undefined]) {
    assert.equal(effortSetting(value), "", `${JSON.stringify(value)} must normalise to unset`);
  }
});

test("a valid level survives casing and surrounding space", () => {
  assert.equal(effortSetting("high"), "high");
  assert.equal(effortSetting("  MAX  "), "max");
  assert.equal(effortSetting("XHigh"), "xhigh");
});

test("unset sends nothing to either provider", () => {
  // This is what keeps older models working: the request is byte-identical to one
  // made before the feature existed.
  assert.deepEqual(bedrockEffortFields(""), {});
  assert.deepEqual(claudeEffortArgs(""), []);
});

test("a level maps onto the exact shape Bedrock asked for", () => {
  // `thinking.type: enabled` is rejected by this model family, which replies "Use
  // \"thinking.type.adaptive\" and \"output_config.effort\" to control thinking".
  assert.deepEqual(bedrockEffortFields("high"), {
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
  });
  for (const level of EFFORT_LEVELS) {
    const fields = bedrockEffortFields(level) as { output_config: { effort: string } };
    assert.equal(fields.output_config.effort, level);
  }
});

test("a level becomes the CLI's --effort argv", () => {
  assert.deepEqual(claudeEffortArgs("max"), ["--effort", "max"]);
  for (const level of EFFORT_LEVELS) {
    assert.deepEqual(claudeEffortArgs(level), ["--effort", level]);
  }
});

test("labels are readable, not mechanically capitalised", () => {
  // "xhigh" title-cased is "Xhigh", which reads as a typo in a picker.
  assert.equal(effortLabel("xhigh"), "Extra high");
  assert.equal(effortLabel("max"), "Maximum");
  assert.equal(effortLabel("low"), "Low");
  assert.equal(effortLabel(""), "Provider default");
});
