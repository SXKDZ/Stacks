import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { SnippetAttachmentListSchema, type SnippetAttachment } from "@/app/lib/schemas/attachments";
import { parseJsonWith } from "@/app/lib/schemas/parse";

/**
 * Clone attachments selected as historical context into a new feed directory.
 *
 * Library papers remain lightweight references and never copy their source PDF.
 * Only uploads (and legacy files that were already staged inside the source feed)
 * are copied. Unsafe or missing relative paths are omitted from the new feed.
 */
export function copyFeedHistoryAttachments(
  sourceWorkingDir: string,
  targetWorkingDir: string,
  raw: string | null | undefined,
): SnippetAttachment[] {
  if (!raw) return [];
  const parsed = parseJsonWith(SnippetAttachmentListSchema, raw);
  if (!parsed.ok) return [];

  const copied: SnippetAttachment[] = [];
  for (const attachment of parsed.data) {
    if (!attachment.relativePath) {
      copied.push(attachment);
      continue;
    }
    const source = resolve(sourceWorkingDir, attachment.relativePath);
    const target = resolve(targetWorkingDir, attachment.relativePath);
    const sourceEscape = relative(sourceWorkingDir, source);
    const targetEscape = relative(targetWorkingDir, target);
    if (sourceEscape.startsWith("..") || targetEscape.startsWith("..") || !existsSync(source)) {
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) copyFileSync(source, target);
    copied.push(attachment);
  }
  return copied;
}
