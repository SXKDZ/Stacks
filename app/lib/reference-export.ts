import type { Paper } from "./types";

export type ReferenceExportFormat = "bibtex" | "ieee" | "markdown" | "html" | "json";

export const referenceExportFormats: Array<{ id: ReferenceExportFormat; label: string; extension: string; mime: string }> = [
  { id: "bibtex", label: "BibTeX", extension: "bib", mime: "application/x-bibtex" },
  { id: "ieee", label: "IEEE", extension: "txt", mime: "text/plain" },
  { id: "markdown", label: "Markdown", extension: "md", mime: "text/markdown" },
  { id: "html", label: "HTML", extension: "html", mime: "text/html" },
  { id: "json", label: "JSON", extension: "json", mime: "application/json" },
];

function clean(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function escapeBibtex(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([{}%&_#$])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

function citationKey(paper: Paper): string {
  const family = paper.authors[0]?.displayName.split(/\s+/).at(-1) ?? "paper";
  const significant = paper.title.split(/\s+/).find((word) => word.replace(/[^A-Za-z0-9]/g, "").length > 3) ?? "work";
  const raw = `${family}${paper.year ?? "nd"}${significant}`.replace(/[^A-Za-z0-9]/g, "");
  return raw || `paper${paper.id.replace(/[^A-Za-z0-9]/g, "").slice(-8)}`;
}

function bibtexEntry(paper: Paper): string {
  const venue = clean(paper.venueAcronym) || clean(paper.venueName);
  const preprint = paper.paperType.toLowerCase().includes("preprint") || Boolean(paper.arxivId || paper.preprintId);
  const journal = paper.paperType.toLowerCase().includes("journal");
  const entryType = journal || preprint ? "article" : "inproceedings";
  const fields: Array<[string, string]> = [
    ["title", paper.title],
    ["author", paper.authors.map((author) => author.displayName).join(" and ")],
    ["year", paper.year?.toString() ?? ""],
  ];
  if (preprint) {
    fields.push(["journal", venue || "arXiv.org"]);
    const eprint = clean(paper.arxivId) || clean(paper.preprintId).replace(/^arxiv:\s*/i, "");
    if (eprint) {
      fields.push(["eprint", eprint], ["eprinttype", "arxiv"]);
    }
    if (paper.category) fields.push(["eprintclass", paper.category]);
  } else if (journal) {
    if (venue) fields.push(["journal", venue]);
    if (paper.volume) fields.push(["volume", paper.volume]);
    if (paper.issue) fields.push(["number", paper.issue]);
    if (paper.pages) fields.push(["pages", paper.pages]);
  } else {
    if (venue) fields.push(["booktitle", venue]);
    if (paper.pages) fields.push(["pages", paper.pages]);
  }
  if (paper.doi) fields.push(["doi", paper.doi]);
  if (paper.url) fields.push(["url", paper.url]);
  const body = fields
    .filter(([, value]) => clean(value))
    .map(([name, value]) => `  ${name} = {${escapeBibtex(clean(value))}}`)
    .join(",\n");
  return `@${entryType}{${citationKey(paper)},\n${body}\n}`;
}

function ieeeAuthor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const family = parts.at(-1);
  const initials = parts.slice(0, -1).map((part) => `${part.charAt(0).toUpperCase()}.`).join(" ");
  return `${initials} ${family}`;
}

function ieeeEntry(paper: Paper, index: number, numbered: boolean): string {
  const authors = paper.authors.map((author) => ieeeAuthor(author.displayName));
  const authorText = authors.length > 2
    ? `${authors.slice(0, -1).join(", ")}, and ${authors.at(-1)}`
    : authors.join(" and ");
  const venue = clean(paper.venueAcronym) || clean(paper.venueName);
  const parts = [authorText, `“${paper.title},”`, venue ? `in ${venue},` : "", paper.year?.toString() ?? ""]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const identifiers = [paper.volume ? `vol. ${paper.volume}` : "", paper.issue ? `no. ${paper.issue}` : "", paper.pages ? `pp. ${paper.pages}` : "", paper.doi ? `doi: ${paper.doi}` : ""]
    .filter(Boolean)
    .join(", ");
  return `${numbered ? `[${index + 1}] ` : ""}${parts}${identifiers ? `, ${identifiers}` : ""}.`;
}

function markdownEntry(paper: Paper): string {
  const authors = paper.authors.map((author) => author.displayName).join(", ") || "Unknown authors";
  const venue = clean(paper.venueAcronym) || clean(paper.venueName);
  const link = paper.url || paper.pdfUrl;
  return `- **${paper.title}**. ${authors}${venue ? `, *${venue}*` : ""}${paper.year ? ` (${paper.year})` : ""}${paper.doi ? `. DOI: ${paper.doi}` : ""}${link ? ` [Source](${link})` : ""}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] ?? character);
}

function htmlEntry(paper: Paper): string {
  const authors = paper.authors.map((author) => author.displayName).join(", ") || "Unknown authors";
  const venue = clean(paper.venueAcronym) || clean(paper.venueName);
  const link = paper.url || paper.pdfUrl;
  return `<li><strong>${escapeHtml(paper.title)}</strong><br><span>${escapeHtml(authors)}${venue ? ` · <em>${escapeHtml(venue)}</em>` : ""}${paper.year ? ` · ${paper.year}` : ""}</span>${paper.doi ? `<br><span>DOI: ${escapeHtml(paper.doi)}</span>` : ""}${link ? `<br><a href="${escapeHtml(link)}">Source</a>` : ""}</li>`;
}

export function exportReferences(papers: Paper[], format: ReferenceExportFormat): string {
  if (format === "bibtex") return papers.map(bibtexEntry).join("\n\n");
  if (format === "ieee") return papers.map((paper, index) => ieeeEntry(paper, index, papers.length > 1)).join("\n\n");
  if (format === "markdown") return papers.map(markdownEntry).join("\n");
  if (format === "html") return `<!doctype html><html><head><meta charset="utf-8"><title>Stacks references</title></head><body><ol>${papers.map(htmlEntry).join("")}</ol></body></html>`;
  return JSON.stringify(papers.map((paper) => ({
    id: paper.id,
    title: paper.title,
    authors: paper.authors.map((author) => author.displayName),
    year: paper.year,
    venue: paper.venueName,
    venueAcronym: paper.venueAcronym,
    type: paper.paperType,
    doi: paper.doi,
    arxivId: paper.arxivId || paper.preprintId,
    url: paper.url,
    abstract: paper.abstract,
  })), null, 2);
}

export function downloadReferences(papers: Paper[], format: ReferenceExportFormat): void {
  const metadata = referenceExportFormats.find((item) => item.id === format) ?? referenceExportFormats[0];
  const blob = new Blob([exportReferences(papers, format)], { type: `${metadata.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `stacks-references-${new Date().toISOString().slice(0, 10)}.${metadata.extension}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
