export type ViewId =
  | "home"
  | "library"
  | "authors"
  | "venues"
  | "collections"
  | "discover"
  | "settings";

export interface PaperAuthor {
  id: string;
  displayName: string;
  orcid: string | null;
  order: number;
  corresponding: boolean;
}

export interface PaperCollection {
  id: string;
  name: string;
}

export interface Paper {
  id: string;
  title: string;
  abstract: string;
  year: number | null;
  paperType: string;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  category: string | null;
  doi: string | null;
  arxivId: string | null;
  preprintId: string | null;
  semanticScholarId: string | null;
  url: string | null;
  pdfUrl: string | null;
  localPath: string | null;
  htmlSnapshotPath: string | null;
  htmlUrl: string | null;
  summary: string;
  notes: string;
  readingStatus: string;
  favorite: boolean;
  venueId: string | null;
  venueName: string | null;
  venueAcronym: string | null;
  addedAt: string;
  updatedAt: string;
  authors: PaperAuthor[];
  collections: PaperCollection[];
}

export interface Author {
  id: string;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  orcid: string | null;
  semanticScholarId: string | null;
  notes: string | null;
  paperCount: number;
  latestYear: number | null;
}

export interface Venue {
  id: string;
  name: string;
  acronym: string | null;
  type: string;
  publisher: string | null;
  url: string | null;
  notes: string | null;
  paperCount: number;
  latestYear: number | null;
}

export interface Collection {
  id: string;
  name: string;
  paperCount: number;
}

export interface LibrarySnapshot {
  papers: Paper[];
  authors: Author[];
  venues: Venue[];
  collections: Collection[];
  stats: {
    papers: number;
    authors: number;
    venues: number;
    unread: number;
    active: number;
    recent: number;
  };
}

export interface DiscoveryResult {
  source: string;
  sourceId: string | null;
  title: string;
  abstract: string;
  year: number | null;
  authors: string[];
  venueName: string;
  venueAcronym: string;
  paperType: string;
  doi: string | null;
  arxivId: string | null;
  semanticScholarId: string | null;
  url: string | null;
  pdfUrl: string | null;
  citationCount: number;
}

export type DiscoveryProvider =
  | "semantic-scholar"
  | "google-scholar"
  | "arxiv"
  | "dblp"
  | "crossref";

export type IdentifierSource = "arxiv" | "doi" | "dblp" | "openreview";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}
