/**
 * Library changes an agent proposes, and the user approves.
 *
 * This is the app's least-trusted boundary: the JSON is composed by a model,
 * arrives either in a fenced block in the transcript or as a POST from the
 * agent's own curl, and anything that survives here becomes a queued mutation
 * against the user's library. So the shape is checked strictly, and a stale or
 * invented field fails loudly instead of being dropped on the floor.
 *
 * `id` is required exactly on the actions that act on an existing record, as a
 * discriminated union rather than an `if`, so an applier cannot read
 * `operation.id` on a create branch where it doesn't exist.
 */
import { z } from "zod";

import { LibraryEntitySchema, PaperDataSchema } from "./library";
import { describeZodError } from "./parse";

/** Fields every proposal carries, whatever its action. */
const proposalBase = {
  entity: LibraryEntitySchema,
  summary: z.string().optional(),
};

/**
 * The canonical operation shape. `strictObject` rejects unknown keys: a model
 * that invents `{ confidence: 0.9 }` or a proposal persisted by an older
 * version with a since-removed field fails validation instead of being
 * silently accepted minus the part nobody read.
 */
export const ProposalOperationSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...proposalBase,
    action: z.literal("create"),
    data: PaperDataSchema,
  }),
  z.strictObject({
    ...proposalBase,
    action: z.literal("update"),
    id: z.string().trim().min(1),
    data: PaperDataSchema,
  }),
  z.strictObject({
    ...proposalBase,
    action: z.literal("delete"),
    id: z.string().trim().min(1),
  }),
]);
export type ProposalOperation = z.infer<typeof ProposalOperationSchema>;

/**
 * The same contract, relaxed at the points a language model reliably gets
 * wrong: it often omits `summary` (we derive one) and omits `data` on a create
 * or update (an empty record is harmless, and the library route rejects a paper
 * with no title anyway). Nothing structural is relaxed: entity, action, and the
 * id-per-action requirement still hold, and unknown keys are still refused.
 *
 * Derived from the canonical schemas rather than written out again, so the two
 * cannot drift apart.
 */
const [createOperation, updateOperation, deleteOperation] = ProposalOperationSchema.options;

export const AgentProposalOperationSchema = z.discriminatedUnion("action", [
  createOperation.extend({ data: PaperDataSchema.prefault({}) }),
  updateOperation.extend({ data: PaperDataSchema.prefault({}) }),
  deleteOperation,
]);

/** A human-readable label for a proposal, used when the agent omits one. */
export function proposalSummary(operation: ProposalOperation): string {
  return operation.summary ?? `${operation.action} ${operation.entity}`;
}

/** Just the fields a label needs, read out of a stored operation. */
const ProposalLabelSchema = z.object({
  summary: z.string().trim().min(1).optional(),
  action: z.string().trim().optional(),
  entity: z.string().trim().optional(),
}).loose();

/**
 * The same label, for an operation already serialized into the database. Parsed
 * loosely on purpose: a label is all these callers want, and a row written by an
 * older version with a since-removed field would fail the strict schema and lose
 * a perfectly good summary. `fallback` is what to say when even that much is
 * unreadable, since the wording differs by where it is shown.
 */
export function storedProposalSummary(operation: string, fallback: string): string {
  const parsed = ProposalLabelSchema.safeParse(safeJson(operation));
  if (!parsed.success) return fallback;
  if (parsed.data.summary) return parsed.data.summary;
  return [parsed.data.action, parsed.data.entity].filter(Boolean).join(" ") || fallback;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Validate a batch, keeping the operations that parse and reporting the ones
 * that don't. The transcript parser needs this partial behavior: one malformed
 * entry in a block of five shouldn't discard the other four, but the failures
 * must still be visible rather than vanishing (which is what the previous
 * hand-written parser did with a bare `continue`).
 */
export function parseProposalBatch(value: unknown): {
  operations: ProposalOperation[];
  errors: string[];
} {
  if (!Array.isArray(value)) {
    const single = AgentProposalOperationSchema.safeParse(value);
    return single.success
      ? { operations: [single.data], errors: [] }
      : { operations: [], errors: [describeZodError(single.error)] };
  }
  const operations: ProposalOperation[] = [];
  const errors: string[] = [];
  value.forEach((item, index) => {
    const result = AgentProposalOperationSchema.safeParse(item);
    if (result.success) {
      operations.push(result.data);
    } else {
      errors.push(`proposal ${index + 1}: ${describeZodError(result.error)}`);
    }
  });
  return { operations, errors };
}

/**
 * The wrapper shapes the agent may post its proposals in. The operations
 * themselves are validated separately (against the schemas above), so this only
 * describes the envelope: `{ proposals: [...] }`, `{ operation: {...} }`, or the
 * operation inline as the body itself.
 */
export const ProposalEnvelopeSchema = z.object({
  proposals: z.array(z.unknown()).optional(),
  operation: z.unknown().optional(),
}).loose();
