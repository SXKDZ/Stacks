/**
 * What a feed turn attached, as persisted in `feed_snippets.attachments` /
 * `feed_messages.attachments` (a JSON string column).
 *
 * Both the server (GitHub mirroring) and the client (attachment chips) read that
 * column, so the shape lives here rather than beside either reader. It is stored
 * data, but old rows were written by earlier versions of this shape, which is
 * exactly why it gets parsed rather than cast: a row from a previous kind set
 * degrades to "no attachments" instead of rendering undefined fields.
 */
import { z } from "zod";

export const SnippetAttachmentSchema = z.object({
  /** `paper-pdf`/`paper-html` are legacy kinds from when papers were copied in. */
  kind: z.enum(["upload", "paper", "paper-pdf", "paper-html"]),
  /** A short human label for the prompt/UI (paper title or original filename). */
  label: z.string(),
  /** Uploads (and legacy staged papers): path relative to the working dir. */
  relativePath: z.string().optional(),
  /** Referenced library papers: the paper id the agent reads by API. */
  paperId: z.string().optional(),
});
export type SnippetAttachment = z.infer<typeof SnippetAttachmentSchema>;

/**
 * A turn's attachment list. Individual malformed entries are dropped rather than
 * failing the list, so one bad row can't blank out a turn's other attachments.
 */
export const SnippetAttachmentListSchema = z
  .array(z.unknown())
  .transform((items) =>
    items
      .map((item) => SnippetAttachmentSchema.safeParse(item))
      .filter((result) => result.success)
      .map((result) => result.data),
  );
