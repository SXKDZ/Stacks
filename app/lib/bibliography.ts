export type BibliographyFormat = "bibtex" | "ris";

export interface BibliographyPaper {
  title: string;
  abstract: string;
  year: number | null;
  authors: string[];
  venueName: string;
  venueAcronym: string;
  paperType: string;
  doi: string | null;
  url: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  preprintId: string | null;
  readingStatus: "inbox";
}

function cleanText(value: string): string {
  return value
    .replace(/[{}]/g, "")
    .replace(/\\([&%_$#])/g, "$1")
    .replace(/\\(?:textit|textbf|emph)\s*/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanOptional(value?: string): string | null {
  const cleaned = value ? cleanText(value) : "";
  return cleaned || null;
}

function parseYear(value?: string): number | null {
  const match = value?.match(/(?:15|16|17|18|19|20|21)\d{2}/);
  return match ? Number(match[0]) : null;
}

function parseBibAuthors(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/\s+and\s+/i)
    .map((author) => cleanText(author))
    .map((author) => {
      const [family, ...given] = author.split(",").map((part) => part.trim());
      return given.length ? `${given.join(" ")} ${family}`.trim() : family;
    })
    .filter(Boolean);
}

function inferBibType(entryType: string): string {
  if (entryType === "article") {
    return "journal";
  }
  if (entryType === "inproceedings" || entryType === "conference") {
    return "conference";
  }
  if (entryType === "inbook" || entryType === "incollection") {
    return "workshop";
  }
  if (entryType === "misc" || entryType === "unpublished") {
    return "preprint";
  }
  return "other";
}

function readDelimitedValue(source: string, start: number): { value: string; end: number } {
  const opener = source[start];
  if (opener !== "{" && opener !== '"') {
    const comma = source.indexOf(",", start);
    const end = comma === -1 ? source.length : comma;
    return { value: source.slice(start, end).trim(), end };
  }

  const closer = opener === "{" ? "}" : '"';
  let depth = 1;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (opener === "{" && character === opener) {
      depth += 1;
    } else if (character === closer) {
      depth -= 1;
      if (depth === 0) {
        return { value: source.slice(start + 1, index), end: index + 1 };
      }
    }
  }
  return { value: source.slice(start + 1), end: source.length };
}

function parseBibFields(source: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /[\s,]/.test(source[index])) {
      index += 1;
    }
    const keyStart = index;
    while (index < source.length && /[\w-]/.test(source[index])) {
      index += 1;
    }
    const key = source.slice(keyStart, index).toLowerCase();
    while (index < source.length && /\s/.test(source[index])) {
      index += 1;
    }
    if (!key || source[index] !== "=") {
      index += 1;
      continue;
    }
    index += 1;
    while (index < source.length && /\s/.test(source[index])) {
      index += 1;
    }
    const parsed = readDelimitedValue(source, index);
    fields[key] = parsed.value;
    index = parsed.end;
  }
  return fields;
}

function extractBibEntries(source: string): Array<{ type: string; fields: Record<string, string> }> {
  const entries: Array<{ type: string; fields: Record<string, string> }> = [];
  let cursor = 0;
  while (cursor < source.length) {
    const marker = source.indexOf("@", cursor);
    if (marker === -1) {
      break;
    }
    const typeMatch = source.slice(marker + 1).match(/^([a-zA-Z]+)\s*([({])/);
    if (!typeMatch) {
      cursor = marker + 1;
      continue;
    }
    const entryType = typeMatch[1].toLowerCase();
    const opener = typeMatch[2];
    const closer = opener === "{" ? "}" : ")";
    const bodyStart = marker + 1 + typeMatch[0].length;
    let depth = 1;
    let quoted = false;
    let escaped = false;
    let bodyEnd = source.length;
    for (let index = bodyStart; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        quoted = !quoted;
        continue;
      }
      if (!quoted && character === opener) {
        depth += 1;
      } else if (!quoted && character === closer) {
        depth -= 1;
        if (depth === 0) {
          bodyEnd = index;
          break;
        }
      }
    }
    const body = source.slice(bodyStart, bodyEnd);
    const firstComma = body.indexOf(",");
    if (firstComma !== -1 && !["comment", "preamble", "string"].includes(entryType)) {
      entries.push({ type: entryType, fields: parseBibFields(body.slice(firstComma + 1)) });
    }
    cursor = bodyEnd + 1;
  }
  return entries;
}

export function parseBibtex(source: string): BibliographyPaper[] {
  return extractBibEntries(source)
    .map(({ type, fields }) => {
      const venueName = fields.booktitle || fields.journal || fields.publisher || "";
      return {
        title: cleanText(fields.title || ""),
        abstract: cleanText(fields.abstract || ""),
        year: parseYear(fields.year || fields.date),
        authors: parseBibAuthors(fields.author),
        venueName: cleanText(venueName),
        venueAcronym: "",
        paperType: inferBibType(type),
        doi: cleanOptional(fields.doi),
        url: cleanOptional(fields.url),
        volume: cleanOptional(fields.volume),
        issue: cleanOptional(fields.number || fields.issue),
        pages: cleanOptional(fields.pages)?.replace(/--/g, "–") ?? null,
        preprintId: cleanOptional(fields.eprint),
        readingStatus: "inbox" as const,
      };
    })
    .filter((paper) => Boolean(paper.title));
}

function inferRisType(type: string): string {
  if (type === "JOUR") {
    return "journal";
  }
  if (type === "CONF" || type === "CPAPER") {
    return "conference";
  }
  if (type === "CHAP" || type === "BOOK") {
    return "workshop";
  }
  if (type === "UNPB" || type === "MANSCPT") {
    return "preprint";
  }
  return "other";
}

export function parseRis(source: string): BibliographyPaper[] {
  const records: Array<Record<string, string[]>> = [];
  let record: Record<string, string[]> = {};
  let lastTag = "";
  for (const line of source.replace(/\r/g, "").split("\n")) {
    const match = line.match(/^([A-Z0-9]{2})\s{2}-\s?(.*)$/);
    if (match) {
      const tag = match[1];
      if (tag === "TY" && Object.keys(record).length) {
        records.push(record);
        record = {};
      }
      record[tag] = [...(record[tag] ?? []), match[2].trim()];
      lastTag = tag;
      if (tag === "ER") {
        records.push(record);
        record = {};
        lastTag = "";
      }
    } else if (lastTag && line.trim()) {
      const values = record[lastTag];
      values[values.length - 1] = `${values[values.length - 1]} ${line.trim()}`;
    }
  }
  if (Object.keys(record).length) {
    records.push(record);
  }

  return records
    .map((fields) => {
      const first = (tag: string): string => fields[tag]?.[0] ?? "";
      const startPage = first("SP");
      const endPage = first("EP");
      const venueName = first("T2") || first("JO") || first("JF") || first("JA");
      return {
        title: cleanText(first("TI") || first("T1") || first("CT")),
        abstract: cleanText(first("AB") || first("N2")),
        year: parseYear(first("PY") || first("Y1") || first("DA")),
        authors: [...(fields.AU ?? []), ...(fields.A1 ?? [])].map(cleanText).filter(Boolean),
        venueName: cleanText(venueName),
        venueAcronym: cleanText(first("J2")),
        paperType: inferRisType(first("TY").toUpperCase()),
        doi: cleanOptional(first("DO")),
        url: cleanOptional(first("UR") || first("L1")),
        volume: cleanOptional(first("VL")),
        issue: cleanOptional(first("IS")),
        pages: cleanOptional(startPage && endPage ? `${startPage}–${endPage}` : startPage),
        preprintId: null,
        readingStatus: "inbox" as const,
      };
    })
    .filter((paper) => Boolean(paper.title));
}

export function parseBibliography(source: string, format: BibliographyFormat): BibliographyPaper[] {
  return format === "bibtex" ? parseBibtex(source) : parseRis(source);
}
