/**
 * Normalize a repository identifier into the one stored Preprint ID field.
 *
 * arXiv arrives as a bare id, an `arXiv:` value, or an abs/pdf URL (sometimes
 * with a version). They all refer to the same preprint, so keep one readable
 * canonical value. Other repositories keep their supplied identifier.
 */
export function canonicalPreprintId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  const withoutQuery = raw.replace(/[?#].*$/, "");
  const arxivInput = /^(?:https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/|arxiv[:\s]+)/i.test(withoutQuery);
  if (!arxivInput && !/^(?:[a-z-]+(?:\.[a-z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i.test(withoutQuery)) {
    return raw;
  }

  const identifier = withoutQuery
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/^arxiv[:\s]*/i, "")
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "")
    .trim()
    .toLowerCase();
  return identifier ? `arXiv:${identifier}` : null;
}
