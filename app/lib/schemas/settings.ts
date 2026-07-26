/**
 * The on-disk shape of `settings.json`, and the payload the settings UI posts.
 *
 * The file is state Stacks wrote, but it is still an untrusted input: users edit
 * it by hand, a crash can truncate it, an older version wrote a different
 * shape, and a OneDrive restore can bring back a stale one. Reading it with a
 * cast meant a malformed value (`maxTokens: "abc"`, a missing `ai` block) was
 * only noticed when something downstream tried to use it, e.g. as a request
 * parameter to Bedrock.
 *
 * Nested blocks carry defaults so a file missing one still loads: a partially
 * corrupt settings file degrades to defaults for the broken part instead of
 * failing the whole read and silently resetting everything.
 */
import { z } from "zod";

/** Secret values are stored as plain strings, keyed by their env-var name. */
const SecretsSchema = z.record(z.string(), z.string());

/**
 * Stored as strings (they come from text inputs) but they are numbers: the whole
 * point of validating this file was to stop `maxTokens: "abc"` reaching Bedrock
 * as a request parameter, so the numeric shape is enforced here.
 */
const numericText = (label: string) =>
  z.string().refine((value) => value.trim() !== "" && Number.isFinite(Number(value)), {
    message: `${label} must be a number.`,
  });

const AiSettingsSchema = z.object({
  modelId: z.string(),
  region: z.string(),
  maxTokens: numericText("maxTokens"),
  temperature: numericText("temperature"),
  // Whether to send `temperature` at all. Newer models reject the parameter
  // outright ("`temperature` is deprecated for this model"), and there is no way to
  // tell from a model id which ones do, so this is the user's call rather than a
  // hardcoded list that goes stale with every release. Stored as text like the
  // other fields in this block.
  sendTemperature: z.string().catch("true"),
});

const PromptSettingsSchema = z.object({
  extractionSystem: z.string(),
  summarySystem: z.string(),
});

const SyncSettingsSchema = z.object({
  remotePath: z.string(),
  autoSync: z.string(),
  autoSyncInterval: z.string(),
});

const GithubSettingsSchema = z.object({
  repo: z.string(),
  /** ISO timestamp of the last successful inbox sync, for incremental pulls. */
  lastSyncedAt: z.string().optional(),
  /** The repo the local issue/comment links belong to. When it differs from
   *  `repo` (the user switched repos), sync unlinks every feed first so stale
   *  issue numbers can't touch the wrong repo's issues. */
  linkedRepo: z.string().optional(),
});

export const FeedSkillSchema = z.object({
  id: z.string(),
  label: z.string(),
  icon: z.string(),
  prompt: z.string(),
});

export const FeedWorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  script: z.string(),
});

/**
 * `version` is a literal, so a file from a future or unrecognized schema
 * version fails the parse and is treated as absent rather than being read with
 * today's assumptions.
 */
export const StructuredSettingsFileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  /** The user-facing library name shown in the sidebar status. */
  libraryName: z.string().optional(),
  // Each block is independently recoverable: a file whose `sync` block is
  // corrupt still yields its saved model and secrets, rather than the whole read
  // failing and every setting appearing unset (which, for the secrets block,
  // looks to the user like their API tokens were silently discarded).
  ai: AiSettingsSchema.catch(() => ({ modelId: "", region: "", maxTokens: "10000", temperature: "0.25", sendTemperature: "true" })),
  prompts: PromptSettingsSchema.catch(() => ({ extractionSystem: "", summarySystem: "" })),
  sync: SyncSettingsSchema.catch(() => ({ remotePath: "", autoSync: "false", autoSyncInterval: "5" })),
  github: GithubSettingsSchema.optional(),
  feedSkills: z.array(FeedSkillSchema).optional(),
  // Saved Claude Code workflow scripts (the `export const meta` + body form),
  // run against the library through the approval-gated feed. name/description
  // are parsed from the script's meta for the list; script is the source.
  feedWorkflows: z.array(FeedWorkflowSchema).optional(),
  secrets: SecretsSchema.catch(() => ({})),
});
export type StructuredSettingsFile = z.infer<typeof StructuredSettingsFileSchema>;

/**
 * What the settings form POSTs. Numbers are accepted where the file stores
 * strings (a number input yields a number), and every field is optional because
 * the form saves one section at a time.
 */
export const SettingsPayloadSchema = z.object({
  libraryName: z.string().optional(),
  modelId: z.string().optional(),
  region: z.string().optional(),
  maxTokens: z.union([z.string(), z.number()]).optional(),
  temperature: z.union([z.string(), z.number()]).optional(),
  sendTemperature: z.boolean().optional(),
  extractionSystemPrompt: z.string().optional(),
  summarySystemPrompt: z.string().optional(),
  remotePath: z.string().optional(),
  autoSync: z.boolean().optional(),
  autoSyncInterval: z.union([z.string(), z.number()]).optional(),
  githubRepo: z.string().optional(),
  secrets: SecretsSchema.optional(),
});
export type SettingsPayload = z.infer<typeof SettingsPayloadSchema>;

/**
 * The result the Python sync bridge prints as its last stdout line.
 *
 * A separate process wrote this, so its shape can drift from what the app
 * expects independently of any TypeScript change. Validating it means a bridge
 * that changes its output (or crashes mid-write, leaving truncated JSON) fails
 * with a clear message instead of surfacing as an empty sync summary.
 */
export const SyncResultSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  changes: z.record(z.string(), z.number()),
  details: z.record(z.string(), z.array(z.string())),
  conflicts: z.number(),
  errors: z.array(z.string()),
  cancelled: z.boolean(),
  progress: z.array(z.object({ message: z.string() }).loose()),
  logs: z.array(z.object({ action: z.string(), details: z.string() }).loose()),
}).loose();
export type SyncResult = z.infer<typeof SyncResultSchema>;
