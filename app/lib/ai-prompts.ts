export const DEFAULT_SUMMARY_SYSTEM_PROMPT = [
  "You are an expert academic paper reviewer specializing in careful technical analysis.",
  "Only include information explicitly present in the supplied paper. Never hallucinate, infer unreported results, or silently fill gaps.",
  "If a section is not applicable or not described, say so directly.",
  "Write concise GitHub-flavored Markdown using these exact sections:",
  "## Motivation — explain the problem or knowledge gap that motivated the work.",
  "## Objective — state the primary objective, core idea, or hypothesis in accessible language.",
  "## Technical approach — explain the methods, models, algorithms, and study procedure in sufficient technical detail.",
  "## Distinctive features — identify what the authors explicitly present as different from prior work.",
  "## Experimental setup and results — describe the design, data, baselines, metrics, and reported findings; state when the work is theoretical or evidence is unavailable.",
  "## Advantages and limitations — separate reported strengths from limitations and open questions; do not invent either.",
  "## Conclusion — synthesize the approach, novelty, evidence, comparative position, and limitations.",
  "Use compact lists where they improve readability. Preserve mathematical expressions with $...$ inline and $$...$$ for display equations.",
  "\n\nPaper to summarize:\n{{paper}}",
].join(" ");

export const DEFAULT_EXTRACTION_SYSTEM_PROMPT = [
  "You are an expert at extracting bibliographic metadata from academic papers.",
  "Use only the supplied PDF text and embedded metadata. Never infer unavailable values.",
  "Return one valid JSON object without Markdown fences using exactly these keys:",
  '"title", "authors", "abstract", "year", "venueName", "venueAcronym", "paperType", "doi", "url", "category", and "preprintId".',
  '"authors" must be an ordered array of names; "year" must be an integer or null;',
  '"paperType" must be one of "conference", "journal", "workshop", "preprint", or "other".',
  "Use null for unavailable scalar values and an empty array for unavailable authors.",
  "For conferences, remove proceedings and ordinal wording from venueName and use the common conference acronym.",
  "For journals, use the full journal name and a conventional abbreviated venueAcronym when present.",
  "\n\nFile: {{filename}}\nEmbedded metadata: {{embedded_metadata}}\n\nPDF text:\n{{source_text[1:2]}}",
].join(" ");

/** A 1-indexed, inclusive page range requested by a prompt placeholder. */
export interface PageSlice {
  start: number;
  /** null means "to the end". */
  end: number | null;
}

/**
 * Read a Python-style page slice off a prompt placeholder so PDF page ranges
 * are controlled in the prompt itself (not a global setting). For `token`:
 *   {{token}}        → all pages          {{token[3]}}    → page 3 only
 *   {{token[1:20]}}  → pages 1–20         {{token[5:]}}   → page 5 to the end
 *   {{token[:10]}}   → pages 1–10
 * Pages are 1-indexed and inclusive. Returns null if the token is absent.
 */
export function pageSliceFor(template: string, token: string): PageSlice | null {
  const match = template.match(new RegExp(`\\{\\{\\s*${token}\\s*(?:\\[\\s*(\\d*)\\s*(:)?\\s*(\\d*)\\s*\\])?\\s*\\}\\}`));
  if (!match) {
    return null;
  }
  const [, a, colon, b] = match;
  if (a === undefined && !colon && b === undefined) {
    return { start: 1, end: null }; // plain {{token}}
  }
  if (!colon) {
    const page = Number(a) || 1; // {{token[3]}} — single page
    return { start: page, end: page };
  }
  return {
    start: a ? Math.max(1, Number(a)) : 1,
    end: b ? Number(b) : null,
  };
}

export function renderPromptTemplate(
  template: string,
  replacements: Record<string, string>,
): string {
  let rendered = template;
  for (const [key, value] of Object.entries(replacements)) {
    // Replace {{key}} and any sliced form {{key[a:b]}} with the resolved value.
    rendered = rendered.replace(new RegExp(`\\{\\{\\s*${key}\\s*(?:\\[[^\\]]*\\])?\\s*\\}\\}`, "g"), () => value);
  }
  return rendered;
}
