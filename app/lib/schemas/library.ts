/**
 * The library write API's wire contract.
 *
 * `/api/library` accepts one shape per action, and the actions have genuinely
 * different requirements: an update needs an id, a bulk-create needs a paper
 * list, a create must not carry either. Expressing that as a discriminated
 * union on `action` makes those requirements types rather than a chain of
 * hand-written `if (!ids[0]) return jsonError(...)` guards: after a successful
 * parse, `request.ids` only exists on the branches that have ids, so a handler
 * cannot read a field the action never carries.
 *
 * Field-level paper data stays `unknown`-valued on purpose (see PaperDataSchema)
 * because it is normalized downstream, not validated here.
 */
import { z } from "zod";

export const LibraryEntitySchema = z.enum(["paper", "author", "venue", "collection"]);
export type LibraryEntity = z.infer<typeof LibraryEntitySchema>;

/**
 * A record's editable fields, as they arrive from a form, an importer, or an
 * approved agent proposal. Deliberately an open record of unknown values: the
 * library route owns normalization (title casing, author-name ordering, page
 * dashes, numeric coercion from form strings) and each writer reads only the
 * fields it understands. Validating individual fields here would duplicate that
 * logic in a second place and reject valid legacy shapes.
 */
export const PaperDataSchema = z.record(z.string(), z.unknown());

/** Bulk import: a list of paper records, capped to keep one request bounded. */
const BulkCreateDataSchema = z.object({
  papers: z.array(z.unknown()).max(500, "Import no more than 500 papers at a time."),
}).loose();

const withEntity = { entity: LibraryEntitySchema };

/**
 * `id`/`ids` both exist because the client sends a single id for one-record
 * updates and an array for bulk ones. `idList()` below is the single place that
 * collapses them, so handlers never re-derive it.
 */
const idFields = {
  id: z.string().min(1).optional(),
  ids: z.array(z.string().min(1)).optional(),
};

export const LibraryMutationSchema = z.discriminatedUnion("action", [
  z.object({
    ...withEntity,
    action: z.literal("create"),
    data: PaperDataSchema.optional(),
  }),
  z.object({
    entity: z.literal("paper"),
    action: z.literal("bulk-create"),
    data: BulkCreateDataSchema,
  }),
  z.object({
    ...withEntity,
    ...idFields,
    action: z.literal("update"),
    data: PaperDataSchema.optional(),
  }),
  z.object({
    ...withEntity,
    ...idFields,
    action: z.literal("bulk-update"),
    data: PaperDataSchema.optional(),
  }),
  z.object({
    ...withEntity,
    ...idFields,
    action: z.literal("delete"),
  }),
  z.object({
    ...withEntity,
    ...idFields,
    action: z.literal("bulk-delete"),
  }),
]);
export type LibraryMutation = z.infer<typeof LibraryMutationSchema>;

/**
 * The ids a mutation targets, from either `ids` or the single `id`.
 *
 * Checks each key independently: an absent optional field is omitted from the
 * parsed object entirely, so testing for one key says nothing about the other.
 * (Branches with no id fields at all, create and bulk-create, yield an empty
 * list.)
 */
export function idList(mutation: LibraryMutation): string[] {
  const ids = "ids" in mutation ? mutation.ids : undefined;
  if (ids?.length) {
    return ids;
  }
  const id = "id" in mutation ? mutation.id : undefined;
  return id ? [id] : [];
}
