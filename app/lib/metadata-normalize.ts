/**
 * Metadata normalization ported from PaperCLI (ng/services/utils.py). Applied on
 * import and manual entry so titles, author lists, pages, and abstracts land in
 * a consistent shape.
 *
 * Key fidelity notes (matching PaperCLI exactly):
 *  - Titles are title-cased with the NYT "titlecase" rules, wrapped with
 *    acronym preservation (any [A-Z]{2,} run in the original, plus OR/LLM, plus
 *    all-caps hyphen segments) and forced capitalization of both halves of a
 *    hyphenated word.
 *  - Author names are NOT case-corrected — only "Last, First" is reordered to
 *    "First Last" and multi-author strings are split. (PaperCLI has no
 *    particle/initials/casing logic; replicating that would diverge.)
 *  - pages: `--` and en-dash collapse to a single hyphen.
 *  - abstract/title: broken lines are rejoined (newline not followed by an
 *    uppercase letter becomes a space) and whitespace collapsed.
 */

// --- titlecase (NYT Manual of Style), ported from the `titlecase` PyPI package ---

const SMALL = "a|an|and|as|at|but|by|en|for|if|in|of|on|or|the|to|v\\.?|via|vs\\.?";
const PUNCT = "!\"#$%&'‘()*+,\\-–‒—―./:;?@[\\\\\\]_`{|}~";

const SMALL_WORDS = new RegExp(`^(?:${SMALL})$`, "i");
const SMALL_FIRST = new RegExp(`^([${PUNCT}]*)(${SMALL})\\b`, "i");
const SMALL_LAST = new RegExp(`\\b(${SMALL})[${PUNCT}]?$`, "i");
const SUBPHRASE = new RegExp(`([:.;?!\\-–‒—―][ ])(${SMALL})`);
const APOS_SECOND = /^[dol]['‘][\w]+(?:['']{2})?$/i;
const UC_ELSEWHERE = new RegExp(`[${PUNCT}]*?[a-zA-Z]+[A-Z]+?`);
const CAPFIRST = new RegExp(`^[${PUNCT}]*?([\\w])`);
const UC_INITIALS = /^(?:[A-Z]\.|[A-Z]\.[A-Z])+$/;
const MAC_MC = /^([Mm]c|MC)(\w.+)/;
const MR_MRS_MS_DR = /^((m((rs?)|s))|Dr)$/i;
const INLINE_PERIOD = /[\w][.][\w]/;
const CONSONANTS = "bcdfghjklmnpqrstvwxz";

function capitalizeFirst(word: string): string {
  return word.replace(CAPFIRST, (match) => match.toUpperCase());
}

type TitleCallback = (word: string, allCaps: boolean) => string | null;

/** Faithful port of titlecase.titlecase (v2.4, small_first_last=True). */
function titlecase(text: string, callback?: TitleCallback): string {
  const allCaps = text === text.toUpperCase();
  const lines = text.split(/[\r\n]+/);
  const processed: string[] = [];

  for (const line of lines) {
    const tokens = line.split(/[\t ]/);
    const words: string[] = [];
    for (const rawWord of tokens) {
      let word = rawWord;
      if (allCaps) {
        if (UC_INITIALS.test(word)) {
          words.push(word);
          continue;
        }
        word = word.toLowerCase();
      }

      if (callback) {
        const result = callback(word, allCaps);
        if (result != null) {
          words.push(result);
          continue;
        }
      }

      if (APOS_SECOND.test(word)) {
        if (!/[A-Z]/.test(word[0])) {
          word = word[0].toLowerCase() + word.slice(1);
        }
        words.push(word[0] + word[1] + word[2].toUpperCase() + word.slice(3));
        continue;
      }
      if (INLINE_PERIOD.test(word) || (!allCaps && UC_ELSEWHERE.test(word))) {
        words.push(word);
        continue;
      }
      if (SMALL_WORDS.test(word)) {
        words.push(word.toLowerCase());
        continue;
      }
      if (word.includes("/") && !word.includes("//")) {
        words.push(word.split("/").map((part) => capitalizeFirst(part)).join("/"));
        continue;
      }
      if (word.includes("-")) {
        words.push(word.split("-").map((part) => titlecase(part, callback)).join("-"));
        continue;
      }
      const macMatch = word.match(MAC_MC);
      if (macMatch) {
        words.push(`${capitalizeFirst(macMatch[1])}${capitalizeFirst(macMatch[2])}`);
        continue;
      }
      // All-consonant word longer than 2 chars → acronym, uppercase it.
      const lettersOnly = word.replace(new RegExp(`[${PUNCT}]`, "g"), "");
      if (lettersOnly.length > 2 && [...lettersOnly.toLowerCase()].every((c) => CONSONANTS.includes(c))) {
        words.push(word.toUpperCase());
        continue;
      }
      if (MR_MRS_MS_DR.test(word)) {
        words.push(capitalizeFirst(word));
        continue;
      }
      words.push(capitalizeFirst(word));
    }

    let result = words.join(" ");
    // small_first_last: re-capitalize a small word if it is first or last.
    result = result.replace(SMALL_FIRST, (_m, lead: string, small: string) => `${lead}${capitalizeFirst(small)}`);
    result = result.replace(SMALL_LAST, (m) => capitalizeFirst(m));
    // Re-capitalize a small word that opens a subphrase (after : . ; ? ! -).
    result = result.replace(SUBPHRASE, (_m, lead: string, small: string) => `${lead}${capitalizeFirst(small)}`);
    processed.push(result);
  }
  return processed.join("\n");
}

// --- PaperCLI wrappers ---

/** Rejoin broken lines (newline not followed by uppercase → space) and collapse whitespace. */
function fixBrokenLines(text: string): string {
  return text.replace(/\n(?![A-Z])/g, " ").replace(/\s+/g, " ").trim();
}

const KNOWN_ACRONYMS = new Set(["OR", "LLM"]);

/** Title-case a paper title with PaperCLI's acronym preservation and hyphen handling. */
export function normalizeTitle(rawTitle: string): string {
  const fixed = fixBrokenLines(rawTitle);
  if (!fixed) {
    return "";
  }
  // Preserve every all-caps run in the ORIGINAL, plus known acronyms, plus
  // all-caps hyphen segments.
  const acronyms = new Set<string>(KNOWN_ACRONYMS);
  for (const match of fixed.matchAll(/\b[A-Z]{2,}\b/g)) {
    acronyms.add(match[0]);
  }
  for (const token of fixed.matchAll(/[A-Za-z-]+/g)) {
    if (token[0].includes("-")) {
      for (const seg of token[0].split("-")) {
        if (seg.length >= 2 && seg === seg.toUpperCase() && /[A-Z]/.test(seg)) {
          acronyms.add(seg);
        }
      }
    }
  }

  const callback: TitleCallback = (word) => {
    if (acronyms.has(word.toUpperCase())) {
      return word.toUpperCase();
    }
    if (word.includes("-")) {
      const parts = word.split("-");
      let changed = false;
      const out = parts.map((part) => {
        if (acronyms.has(part.toUpperCase())) {
          changed = true;
          return part.toUpperCase();
        }
        return part;
      });
      if (changed) {
        return out.join("-");
      }
    }
    return null;
  };

  let cased = titlecase(fixed, callback);
  // Force both halves of a two-segment hyphenated word capitalized.
  cased = cased.replace(/\b([A-Za-z]+)-([A-Za-z]+)\b/g, (_m, left: string, right: string) => {
    const leftOut = acronyms.has(left.toUpperCase()) ? left.toUpperCase() : left[0].toUpperCase() + left.slice(1);
    const rightOut = acronyms.has(right.toUpperCase()) ? right.toUpperCase() : right[0].toUpperCase() + right.slice(1);
    return `${leftOut}-${rightOut}`;
  });
  return cased.replace(/\s+/g, " ").trim();
}

/**
 * Reorder "Last, First" → "First Last" and split multi-author strings.
 * Casing is intentionally NOT touched (matching PaperCLI). Accepts a string or
 * an array; returns a cleaned array of full-name strings.
 */
export function normalizeAuthorNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((author) => String(author).trim()).filter(Boolean);
  }
  if (typeof value !== "string") {
    return [];
  }
  const authorText = value.replace(/\s+/g, " ").trim();
  if (!authorText) {
    return [];
  }

  const parts = authorText.split(",").map((part) => part.trim());
  // Multi-pair "Last, First, Last, First…" heuristic for >2 comma parts.
  // PaperCLI allows a 2-word lastname here, which misreads a plain list of full
  // names ("John Smith, Jane Doe, …") as Last/First pairs. We require a
  // single-word lastname in the multi-pair case so a comma-separated list of
  // full names falls through to being treated as separate authors. (A lone
  // "Last, First" with a multi-word/particle surname is handled below, where a
  // single comma is unambiguous.)
  if (parts.length > 2 && parts.length % 2 === 0) {
    let looksLikeLastFirst = true;
    for (let i = 0; i < parts.length; i += 2) {
      const lastnameWords = parts[i].split(/\s+/).filter(Boolean);
      const firstnameWords = parts[i + 1].split(/\s+/).filter(Boolean);
      if (lastnameWords.length !== 1 || firstnameWords.length === 0) {
        looksLikeLastFirst = false;
        break;
      }
    }
    if (looksLikeLastFirst) {
      const out: string[] = [];
      for (let i = 0; i < parts.length; i += 2) {
        const lastname = parts[i];
        const firstnameMiddle = parts[i + 1];
        if (lastname && firstnameMiddle) {
          out.push(`${firstnameMiddle} ${lastname}`);
        }
      }
      if (out.length) {
        return out;
      }
    }
  }

  // BibTeX " and " separator.
  if (authorText.includes(" and ")) {
    return authorText.split(" and ").map((author) => {
      const trimmed = author.trim();
      if (!trimmed) {
        return "";
      }
      if (trimmed.includes(",")) {
        const [lastname, firstname] = trimmed.split(/,(.+)/).map((s) => s.trim());
        if (lastname && firstname) {
          return `${firstname} ${lastname}`;
        }
      }
      return trimmed;
    }).filter(Boolean);
  }

  if (authorText.includes(",")) {
    // A single "X, Y" is "Last, First" → reorder — UNLESS both sides are
    // multi-word, in which case it's two full names ("John Smith, Jane Doe"):
    // a first-name field is rarely itself a "First Last" pair, whereas a
    // particle surname ("van der Berg, Jan") pairs a multi-word last with a
    // single-word first, which we still reorder.
    if (parts.length === 2 && parts[0] && parts[1]) {
      const leadWords = parts[0].split(/\s+/).filter(Boolean).length;
      const trailWords = parts[1].split(/\s+/).filter(Boolean).length;
      if (leadWords === 1 || trailWords === 1) {
        return [`${parts[1]} ${parts[0]}`];
      }
    }
    // Otherwise commas separate distinct authors ("John Smith, Jane Doe, …").
    return parts.filter(Boolean);
  }
  return [authorText];
}

/** Collapse LaTeX `--` and en-dashes in a page range to a single hyphen. */
export function normalizePages(pages: string): string {
  return pages.replace(/--/g, "-").replace(/–/g, "-").trim();
}

/** Rejoin broken lines in an abstract without changing case. */
export function normalizeAbstract(abstract: string): string {
  return fixBrokenLines(abstract);
}
