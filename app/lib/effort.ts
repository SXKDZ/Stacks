/**
 * Reasoning effort: how much thinking a model does before answering.
 *
 * One vocabulary for both AI paths, because they happen to agree. Verified against
 * the live services rather than assumed:
 *
 * - Bedrock's converse API takes `thinking: { type: "adaptive" }` plus
 *   `output_config: { effort }`, and rejects anything outside this set with
 *   "unknown variant, expected one of low, medium, high, xhigh, max".
 * - `claude --effort` accepts the same five and warns "Valid values: low, medium,
 *   high, xhigh, max" for anything else.
 *
 * "" means "don't send it", which is the default: older models reject the parameter
 * outright (Sonnet 4.5 and Haiku 4.5 answer 400 "output_config.effort: Extra inputs
 * are not permitted"), and nothing in a model id says which. Same reasoning as the
 * temperature switch.
 */

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = typeof EFFORT_LEVELS[number];

/** An effort level, or "" for the provider default. */
export type EffortSetting = EffortLevel | "";

/** Narrow a stored string to a level, treating anything unknown as "unset". */
export function effortSetting(value: string | null | undefined): EffortSetting {
  const trimmed = (value ?? "").trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(trimmed) ? trimmed as EffortLevel : "";
}

/**
 * The `additionalModelRequestFields` for a Bedrock converse call.
 *
 * Empty when no effort is set, so the request is byte-identical to before and a
 * model that rejects the field is unaffected.
 */
export function bedrockEffortFields(effort: EffortSetting): Record<string, unknown> {
  if (!effort) {
    return {};
  }
  // `adaptive` is required alongside the effort: this model family rejects
  // `thinking.type: enabled` and points at adaptive + output_config.effort.
  return { thinking: { type: "adaptive" }, output_config: { effort } };
}

/** The `--effort` argv for `claude -p`, or nothing when unset. */
export function claudeEffortArgs(effort: EffortSetting): string[] {
  return effort ? ["--effort", effort] : [];
}

/**
 * Human label for a level, for the settings and composer pickers.
 *
 * Spelled out rather than capitalised mechanically: "xhigh" title-cased reads
 * "Xhigh", which looks like a typo.
 */
const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

export function effortLabel(effort: EffortSetting): string {
  return effort ? EFFORT_LABELS[effort] : "Provider default";
}
