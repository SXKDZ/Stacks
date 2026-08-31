import type { DiscoveryResult, DiscoveryProvider, IdentifierSource } from "@/app/lib/types";
import { canonicalPreprintId } from "@/app/lib/preprint-id";

type UnknownRecord = Record<string, unknown>;

export class ScholarlyProviderError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ScholarlyProviderError";
    this.status = status;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * How long to wait on a scholarly provider before giving up.
 *
 * A bare `fetch` has no timeout, so a provider that accepts the connection and then
 * stalls leaves the request hanging forever, and the import spinner with it. arXiv
 * does exactly this when it throttles: a browser User-Agent gets an immediate 429,
 * but an unrecognized one is held open indefinitely.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The User-Agent every provider request carries.
 *
 * arXiv's API tarpits unfamiliar clients (verified: `Stacks/0.1` hung past 25s on
 * the same URL that answered a browser UA in 0.1s), so this identifies Stacks in a
 * shape those services accept. PaperCLI sends a browser UA for the same reason.
 */
const USER_AGENT = "Mozilla/5.0 (compatible; Stacks/0.3; +https://github.com/SXKDZ/Stacks)";

/** Status codes worth retrying: the provider is busy rather than refusing. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Fetch from a scholarly provider with a timeout and bounded retries.
 *
 * Every provider gets the same treatment, so one flaky service can't wedge an
 * import and the reason for a failure is always a real message rather than a
 * spinner that never stops.
 */
async function providerFetch(
  url: URL | string,
  options: { headers?: Record<string, string>; label: string; allowStatus?: boolean },
): Promise<Response> {
  const { label, headers } = options;
  // Every provider gets the same retry budget; no caller has ever varied it.
  const attempts = 3;
  let lastStatus = 0;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // How long to wait before the next try, if there is one. Linear backoff.
    let backoff = 600 * attempt;
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, ...headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        return response;
      }
      // A status this function won't retry: hand it back when the caller wants to
      // read the code (a 404 means "no such record", not "provider broken"), and
      // otherwise fail here so every caller doesn't repeat the same check.
      if (!RETRY_STATUSES.has(response.status)) {
        if (options.allowStatus) {
          return response;
        }
        throw providerFailure(label, attempt, response.status, null);
      }
      lastStatus = response.status;
      // Honour Retry-After when the provider sends one, capped so an import never
      // appears to hang.
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        backoff = Math.min(retryAfter * 1000, 3000);
      }
    } catch (error) {
      // A timeout or network failure. Retry, but keep the cause for the message.
      lastError = error;
    }
    if (attempt < attempts) {
      await wait(backoff);
    }
  }
  throw providerFailure(label, attempts, lastStatus, lastError);
}

/** The error explaining why every attempt at `label` failed. */
function providerFailure(label: string, attempts: number, status: number, error: unknown): ScholarlyProviderError {
  if (status === 429 || status === 503) {
    return new ScholarlyProviderError(
      `${label} is rate-limiting this network right now (HTTP ${status}). Stacks retried ${attempts} times. Wait a few minutes, or add the paper by DOI or URL instead.`,
      status,
    );
  }
  if (status) {
    return new ScholarlyProviderError(`${label} returned HTTP ${status} after ${attempts} attempts.`, status);
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new ScholarlyProviderError(
      `${label} did not respond within ${REQUEST_TIMEOUT_MS / 1000}s (tried ${attempts} times). It may be throttling this network.`,
      504,
    );
  }
  const reason = error instanceof Error ? error.message : "network error";
  return new ScholarlyProviderError(`${label} could not be reached: ${reason}.`, 502);
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value == null ? [] : [value];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function stripMarkup(value: unknown): string {
  return asString(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function yearFromDateParts(value: unknown): number | null {
  const record = asRecord(value);
  const parts = asArray(record["date-parts"])[0];
  const year = Array.isArray(parts) ? Number(parts[0]) : NaN;
  return Number.isFinite(year) ? year : null;
}

function result(overrides: Partial<DiscoveryResult>): DiscoveryResult {
  return {
    source: "Academic source",
    sourceId: null,
    title: "Untitled paper",
    abstract: "",
    year: null,
    authors: [],
    venueName: "",
    venueAcronym: "",
    paperType: "article",
    doi: null,
    preprintId: null,
    semanticScholarId: null,
    url: null,
    pdfUrl: null,
    ...overrides,
  };
}

interface SemanticScholarPaper {
  paperId?: string;
  title?: string;
  abstract?: string | null;
  year?: number | null;
  url?: string;
  openAccessPdf?: { url?: string } | null;
  externalIds?: { DOI?: string; ArXiv?: string };
  authors?: Array<{ name?: string }>;
  venue?: string;
  publicationTypes?: string[];
}

async function searchSemanticScholar(query: string, apiKeyOverride?: string): Promise<DiscoveryResult[]> {
  const apiKey = apiKeyOverride || process.env.SEMANTIC_SCHOLAR_API_KEY;
  if (!apiKey) {
    throw new Error("SEMANTIC_SCHOLAR_API_KEY is not configured.");
  }
  const fields = [
    "paperId",
    "title",
    "abstract",
    "year",
    "authors",
    "venue",
    "url",
    "externalIds",
    "openAccessPdf",
    "publicationTypes",
  ].join(",");
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "8");
  url.searchParams.set("fields", fields);
  const response = await providerFetch(url, { headers: { "x-api-key": apiKey }, label: "Semantic Scholar" });
  const payload = await response.json() as { data?: SemanticScholarPaper[] };
  return (payload.data ?? []).map((paper) => result({
    source: "Semantic Scholar",
    sourceId: paper.paperId ?? null,
    title: paper.title ?? "Untitled paper",
    abstract: paper.abstract ?? "",
    year: paper.year ?? null,
    authors: (paper.authors ?? []).map((author) => author.name ?? "").filter(Boolean),
    venueName: paper.venue || "",
    paperType: paper.publicationTypes?.[0]?.toLowerCase() ?? "article",
    doi: paper.externalIds?.DOI ?? null,
    preprintId: canonicalPreprintId(paper.externalIds?.ArXiv ?? null),
    semanticScholarId: paper.paperId ?? null,
    url: paper.url ?? null,
    pdfUrl: paper.openAccessPdf?.url ?? null,
  }));
}

async function searchGoogleScholar(query: string, apiKeyOverride?: string): Promise<DiscoveryResult[]> {
  const apiKey = apiKeyOverride || process.env.SERPAPI_KEY;
  if (!apiKey) {
    throw new Error("SERPAPI_KEY is not configured.");
  }
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_scholar");
  url.searchParams.set("q", query);
  url.searchParams.set("num", "8");
  url.searchParams.set("api_key", apiKey);
  const response = await providerFetch(url, { label: "Google Scholar (SerpAPI)" });
  const payload = await response.json() as { organic_results?: UnknownRecord[] };
  return (payload.organic_results ?? []).map((item) => {
    const publication = asRecord(item.publication_info);
    const resources = asArray(item.resources).map(asRecord);
    const summary = asString(publication.summary);
    const yearMatch = summary.match(/\b(?:19|20)\d{2}\b/);
    return result({
      source: "Google Scholar",
      sourceId: asString(item.result_id) || null,
      title: asString(item.title) || "Untitled paper",
      abstract: asString(item.snippet),
      year: yearMatch ? Number(yearMatch[0]) : null,
      authors: asArray(publication.authors)
        .map((author) => asString(asRecord(author).name))
        .filter(Boolean),
      venueName: summary.split(" - ").at(-1) ?? "",
      url: asString(item.link) || null,
      pdfUrl: resources.length ? asString(resources[0].link) || null : null,
    });
  });
}

function xmlValue(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return stripMarkup(match?.[1] ?? "");
}

function parseArxivFeed(xml: string): DiscoveryResult[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/gi) ?? [];
  return entries.map((entry) => {
    const idUrl = xmlValue(entry, "id");
    const rawId = idUrl.split("/abs/").at(-1)?.replace(/v\d+$/i, "") ?? "";
    const published = xmlValue(entry, "published");
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
      .map((match) => stripMarkup(match[1]))
      .filter(Boolean);
    const pdfMatch = entry.match(/<link[^>]+title=["']pdf["'][^>]+href=["']([^"']+)["']/i)
      ?? entry.match(/<link[^>]+href=["']([^"']+)["'][^>]+title=["']pdf["']/i);
    const doi = entry.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/i);
    return result({
      source: "arXiv",
      sourceId: rawId || idUrl || null,
      title: xmlValue(entry, "title") || "Untitled paper",
      abstract: xmlValue(entry, "summary"),
      year: /^\d{4}/.test(published) ? Number(published.slice(0, 4)) : null,
      authors,
      venueName: "arXiv",
      venueAcronym: "arXiv",
      paperType: "preprint",
      doi: doi ? stripMarkup(doi[1]) : null,
      preprintId: canonicalPreprintId(rawId || null),
      url: idUrl || (rawId ? `https://arxiv.org/abs/${rawId}` : null),
      pdfUrl: pdfMatch?.[1] ?? (rawId ? `https://arxiv.org/pdf/${rawId}` : null),
    });
  });
}

async function searchArxiv(query: string, idOnly = false): Promise<DiscoveryResult[]> {
  const url = new URL("https://export.arxiv.org/api/query");
  if (idOnly) {
    url.searchParams.set("id_list", query.replace(/^arxiv:/i, "").trim());
  } else {
    url.searchParams.set("search_query", `all:${query}`);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", "8");
    url.searchParams.set("sortBy", "relevance");
  }
  const response = await providerFetch(url, { label: "arXiv" });
  const feed = await response.text();
  const results = parseArxivFeed(feed);
  if (idOnly && !results.length) {
    // A 200 with no entry means the id does not exist, which is worth saying
    // plainly rather than reporting "no results" from a successful lookup.
    throw new ScholarlyProviderError(`arXiv has no paper with id ${url.searchParams.get("id_list")}.`, 404);
  }
  return results;
}

function dblpAuthorNames(value: unknown): string[] {
  const record = asRecord(value);
  return asArray(record.author)
    .map((author) => {
      if (typeof author === "string") {
        return author;
      }
      const authorRecord = asRecord(author);
      return asString(authorRecord.text || authorRecord["#text"] || authorRecord.name);
    })
    .filter(Boolean);
}

function dblpInfoResult(value: unknown): DiscoveryResult {
  const info = asRecord(value);
  const key = asString(info.key);
  const ee = asArray(info.ee).map(asString).find(Boolean) ?? "";
  const doi = asString(info.doi) || (/doi\.org\/(.+)$/i.exec(ee)?.[1] ?? "");
  const type = asString(info.type).toLowerCase();
  return result({
    source: "DBLP",
    sourceId: key || asString(info.url) || null,
    title: stripMarkup(info.title) || "Untitled paper",
    year: Number.isFinite(Number(info.year)) ? Number(info.year) : null,
    authors: dblpAuthorNames(info.authors),
    venueName: asString(info.venue),
    paperType: type.includes("conference") ? "conference" : type.includes("journal") ? "journal" : "article",
    doi: doi || null,
    url: asString(info.url) || (key ? `https://dblp.org/rec/${key}` : ee || null),
    pdfUrl: /\.pdf(?:$|\?)/i.test(ee) ? ee : null,
  });
}

async function searchDblp(query: string): Promise<DiscoveryResult[]> {
  const url = new URL("https://dblp.org/search/publ/api");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("h", "8");
  url.searchParams.set("c", "0");
  const response = await providerFetch(url, { headers: { Accept: "application/json" }, label: "DBLP" });
  const payload = asRecord(await response.json());
  const hits = asRecord(asRecord(payload.result).hits);
  return asArray(hits.hit).map((hit) => dblpInfoResult(asRecord(hit).info));
}

function crossrefResult(value: unknown): DiscoveryResult {
  const item = asRecord(value);
  const authors = asArray(item.author).map((author) => {
    const record = asRecord(author);
    return [asString(record.given), asString(record.family)].filter(Boolean).join(" ") || asString(record.name);
  }).filter(Boolean);
  const links = asArray(item.link).map(asRecord);
  const pdf = links.find((link) => /pdf/i.test(asString(link["content-type"])))?.URL;
  const doi = asString(item.DOI);
  // `issued` is what CSL-JSON from doi.org carries; Crossref's own payload uses
  // `published`/`created`. Reading all three means one parser serves both.
  const year = yearFromDateParts(item.published) ?? yearFromDateParts(item.issued) ?? yearFromDateParts(item.created);
  return result({
    source: "Crossref",
    sourceId: doi || asString(item.URL) || null,
    title: stripMarkup(asArray(item.title)[0]) || "Untitled paper",
    abstract: stripMarkup(item.abstract),
    year,
    authors,
    venueName: stripMarkup(asArray(item["container-title"])[0]),
    paperType: asString(item.type).replace(/-/g, " ") || "article",
    doi: doi || null,
    url: asString(item.URL) || (doi ? `https://doi.org/${doi}` : null),
    pdfUrl: asString(pdf) || null,
  });
}

async function searchCrossref(query: string): Promise<DiscoveryResult[]> {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query", query);
  url.searchParams.set("rows", "8");
  url.searchParams.set("select", "DOI,title,abstract,author,published,created,container-title,type,URL,link");
  const response = await providerFetch(url, { label: "Crossref" });
  const payload = asRecord(await response.json());
  return asArray(asRecord(payload.message).items).map(crossrefResult);
}

/**
 * Resolve a DOI to a record.
 *
 * Crossref first, because it carries the richest metadata, then doi.org content
 * negotiation as the fallback. Crossref only knows the DOIs registered with it, so
 * asking it alone made whole registries unresolvable: every `10.48550/arXiv.*` DOI
 * is a DataCite registration and came back 404 even though doi.org resolves it
 * fine. doi.org answers for every registrar, and its CSL-JSON uses the same field
 * names as Crossref's payload, so one parser handles both.
 */
async function importDoi(identifier: string): Promise<DiscoveryResult> {
  const doi = identifier.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").trim();
  // allowStatus: a 404 is "Crossref does not know this DOI", which is the signal to
  // try doi.org rather than a reason to fail.
  const crossref = await providerFetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { label: "Crossref", allowStatus: true });
  if (crossref.ok) {
    return crossrefResult(asRecord(await crossref.json()).message);
  }
  const negotiated = await providerFetch(`https://doi.org/${doi}`, {
    headers: { Accept: "application/vnd.citationstyles.csl+json" },
    label: "doi.org",
    allowStatus: true,
  });
  if (!negotiated.ok) {
    throw new ScholarlyProviderError(
      negotiated.status === 404
        ? `No registry has a record for DOI ${doi}. Check the identifier, or import the paper by URL.`
        : `That DOI could not be resolved (Crossref HTTP ${crossref.status}, doi.org HTTP ${negotiated.status}).`,
      negotiated.status,
    );
  }
  return crossrefResult(await negotiated.json());
}

async function importDblp(identifier: string): Promise<DiscoveryResult> {
  const match = identifier.match(/dblp\.org\/rec\/(.+?)(?:\.html|\.json)?(?:[?#].*)?$/i);
  const key = (match?.[1] ?? identifier).replace(/^\/+|\/+$/g, "").trim();
  if (!/^[A-Za-z0-9_./:-]+$/.test(key)) {
    throw new Error("Enter a valid DBLP record URL or key.");
  }
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const response = await providerFetch(`https://dblp.org/rec/${encodedKey}.bib?param=1`, { headers: { Accept: "application/x-bibtex,text/plain" }, label: "DBLP" });
  const bibtex = await response.text();
  const field = (name: string): string => {
    const regex = new RegExp(`${name}\\s*=\\s*(?:\\{([\\s\\S]*?)\\}|\"([\\s\\S]*?)\")\\s*,?\\s*(?=\\n\\s*[A-Za-z][A-Za-z0-9_-]*\\s*=|\\n\\s*\\})`, "i");
    const match = regex.exec(bibtex);
    return stripMarkup((match?.[1] ?? match?.[2] ?? "")
      .replace(/[{}]/g, "")
      .replace(/\\&/g, "&"));
  };
  const title = field("title");
  if (!title) {
    throw new Error("DBLP returned a record without usable metadata.");
  }
  const doi = field("doi");
  const year = Number(field("year"));
  return result({
    source: "DBLP",
    sourceId: key,
    title,
    authors: field("author").split(/\s+and\s+/i).map((name) => name.trim()).filter(Boolean),
    year: Number.isFinite(year) ? year : null,
    venueName: field("booktitle") || field("journal"),
    paperType: /@inproceedings/i.test(bibtex) ? "conference" : /@article/i.test(bibtex) ? "journal" : "article",
    doi: doi || null,
    url: `https://dblp.org/rec/${key}`,
  });
}

function openReviewValue(content: UnknownRecord, key: string): unknown {
  const value = content[key];
  const record = asRecord(value);
  return Object.prototype.hasOwnProperty.call(record, "value") ? record.value : value;
}

async function importOpenReview(identifier: string): Promise<DiscoveryResult> {
  const match = identifier.match(/[?&]id=([^&]+)/i);
  const id = decodeURIComponent(match?.[1] ?? identifier).trim();
  const urls = [new URL("https://api2.openreview.net/notes"), new URL("https://api.openreview.net/notes")];
  urls.forEach((url) => {
    url.searchParams.set("forum", id);
    url.searchParams.set("limit", "1000");
  });
  let payload: UnknownRecord = {};
  let lastStatus = 0;
  for (const url of urls) {
    // allowStatus: a failure on the first host is expected, since the second is the
    // fallback for it.
    const response = await providerFetch(url, { headers: { Accept: "application/json" }, label: "OpenReview", allowStatus: true });
    lastStatus = response.status;
    if (response.ok) {
      payload = asRecord(await response.json());
      if (asArray(payload.notes).length) {
        break;
      }
    }
  }
  const notes = asArray(payload.notes).map(asRecord);
  const note = notes.find((candidate) => asString(candidate.id) === asString(candidate.forum)) ?? notes[0] ?? {};
  if (!Object.keys(note).length) {
    if (lastStatus === 401 || lastStatus === 403) {
      return result({
        source: "OpenReview",
        sourceId: id,
        title: `OpenReview submission ${id}`,
        paperType: "conference",
        url: `https://openreview.net/forum?id=${encodeURIComponent(id)}`,
        pdfUrl: `https://openreview.net/pdf?id=${encodeURIComponent(id)}`,
      });
    }
    throw new Error(lastStatus
      ? `No public OpenReview submission was found for that ID (${lastStatus}).`
      : "No public OpenReview submission was found for that ID.");
  }
  const content = asRecord(note.content);
  const venue = asString(openReviewValue(content, "venue")) || asString(openReviewValue(content, "venueid"));
  const date = Number(note.pdate || note.odate || note.cdate);
  return result({
    source: "OpenReview",
    sourceId: asString(note.id) || id,
    title: asString(openReviewValue(content, "title")) || "Untitled paper",
    abstract: asString(openReviewValue(content, "abstract")),
    year: Number.isFinite(date) ? new Date(date).getUTCFullYear() : null,
    authors: asArray(openReviewValue(content, "authors")).map(asString).filter(Boolean),
    venueName: venue,
    paperType: "conference",
    doi: asString(openReviewValue(content, "doi")) || null,
    url: `https://openreview.net/forum?id=${encodeURIComponent(id)}`,
    pdfUrl: `https://openreview.net/pdf?id=${encodeURIComponent(id)}`,
  });
}

export async function searchProvider(
  provider: DiscoveryProvider,
  query: string,
  credentials: { semanticScholarApiKey?: string; serpApiKey?: string } = {},
): Promise<DiscoveryResult[]> {
  switch (provider) {
    case "google-scholar":
      return searchGoogleScholar(query, credentials.serpApiKey);
    case "arxiv":
      return searchArxiv(query);
    case "dblp":
      return searchDblp(query);
    case "crossref":
      return searchCrossref(query);
    case "semantic-scholar":
    default:
      return searchSemanticScholar(query, credentials.semanticScholarApiKey);
  }
}

export async function importIdentifier(source: IdentifierSource, identifier: string): Promise<DiscoveryResult> {
  switch (source) {
    case "doi":
      return importDoi(identifier);
    case "dblp":
      return importDblp(identifier);
    case "openreview":
      return importOpenReview(identifier);
    case "arxiv":
      return importArxivId(identifier);
  }
}

/**
 * Resolve an arXiv id, through the Atom API when it will answer and through the
 * paper's DOI when it won't.
 *
 * arXiv's `export.arxiv.org` API throttles by IP, and it does so by accepting the
 * connection and never replying rather than returning 429, so a busy network makes
 * every id look permanently broken.
 *
 * The fallback uses arXiv's DataCite DOI, `10.48550/arXiv.<id>`, which resolves
 * through a different host. Spot-checked against ids from 1997, 2002, 2007, 2014,
 * 2015, 2017 and 2025, including the old `archive/YYMMNNN` form, so the backfill
 * appears to cover the archive; it is a fallback rather than the primary path
 * partly because that is not a guarantee, and partly because the Atom feed carries
 * the category and canonical PDF link that the DOI record lacks.
 */
async function importArxivId(identifier: string): Promise<DiscoveryResult> {
  const id = identifier.replace(/^arxiv:/i, "").trim();
  try {
    const results = await searchArxiv(id, true);
    if (results.length) {
      return results[0];
    }
  } catch (error) {
    // Only a provider being unavailable justifies the fallback. A malformed id
    // should report itself, not send us looking somewhere else.
    if (!(error instanceof ScholarlyProviderError)) {
      throw error;
    }
  }
  // The DOI identifies the paper, not a version: "1706.03762v5" is a 404, so the
  // suffix is dropped before asking.
  const viaDoi = await importDoi(`10.48550/arXiv.${id.replace(/v\d+$/i, "")}`);
  return result({
    ...viaDoi,
    source: "arXiv",
    sourceId: id,
    preprintId: canonicalPreprintId(id),
    venueName: "arXiv",
    venueAcronym: "arXiv",
    paperType: "preprint",
    url: `https://arxiv.org/abs/${id}`,
    pdfUrl: `https://arxiv.org/pdf/${id}`,
  });
}
