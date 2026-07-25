/**
 * The "authors · venue · year" line shown under a paper's title.
 *
 * Shared so the collection cards and the feed's library picker read identically:
 * they list the same papers, and two different summaries of the same record is the
 * kind of drift that makes an interface feel unfinished.
 */

/** The fields this line needs. Any record carrying them can be summarized. */
export interface PaperMetaSource {
  authors?: Array<{ displayName: string }>;
  venueAcronym?: string | null;
  venueName?: string | null;
  year?: number | null;
}

/** How many author names to show before collapsing the rest into "+N". */
const MAX_AUTHORS = 3;

export function paperMetaLine(paper: PaperMetaSource): string {
  const names = (paper.authors ?? []).map((author) => author.displayName).filter(Boolean);
  // Three names, matching the paper detail panel: a long author list otherwise
  // pushed the venue and year out of view entirely.
  const shown = names.slice(0, MAX_AUTHORS).join(", ");
  const authorText = names.length > MAX_AUTHORS ? `${shown} +${names.length - MAX_AUTHORS}` : shown;
  return [authorText, paper.venueAcronym || paper.venueName || "", paper.year ? String(paper.year) : ""]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Case-insensitive substring match across a record's searchable values.
 *
 * Shared so every paper search covers the same fields. An empty query matches
 * everything, which is what makes it safe to apply unconditionally.
 */
export function matchesSearch(values: Array<string | number | null | undefined>, query: string): boolean {
  if (!query.trim()) {
    return true;
  }
  const normalized = query.trim().toLowerCase();
  return values.some((value) => String(value ?? "").toLowerCase().includes(normalized));
}

/**
 * The values a paper should be findable by: its title, every author's name, the
 * venue in both spellings, and the year. Searching the title alone meant a user who
 * remembered the author or the venue but not the exact title could not find it.
 */
export function paperSearchValues(paper: PaperMetaSource & { title?: string }): Array<string | number | null | undefined> {
  return [
    paper.title,
    ...(paper.authors ?? []).map((author) => author.displayName),
    paper.venueAcronym,
    paper.venueName,
    paper.year,
  ];
}
