/**
 * Request-body contracts for the app's remaining API routes.
 *
 * These were previously `await request.json() as SomeRequest` plus a handful of
 * hand-written presence checks per handler. Declaring the shape once per route
 * means a malformed body is refused at the boundary with the offending field
 * named, and the route's own type comes from the same declaration.
 *
 * Enum fields are spelled out here rather than imported from the `type` unions
 * in app/lib/types.ts so the runtime check and the type stay one definition;
 * the derived types are assignable to those unions.
 */
import { z } from "zod";

/** A non-empty string after trimming, which is what most handlers actually want. */
const requiredText = (message: string) => z.string().trim().min(1, message);

export const DiscoverRequestSchema = z.object({
  query: requiredText("Enter a search query."),
  provider: z.enum(["semantic-scholar", "google-scholar", "arxiv", "dblp", "crossref"]).optional(),
});

export const ImportUrlRequestSchema = z.object({
  url: requiredText("Enter a URL to import."),
});

export const ImportIdentifierRequestSchema = z.object({
  source: z.enum(["arxiv", "doi", "dblp", "openreview"]).prefault("arxiv"),
  identifier: requiredText("Enter an identifier or record URL."),
});

export const ImportBibliographyRequestSchema = z.object({
  format: z.enum(["bibtex", "ris"], { message: "Choose a BibTeX or RIS file." }),
  content: requiredText("The selected bibliography file is empty."),
});

export const SummarizeRequestSchema = z.object({
  paper: z.object({
    title: z.string().optional(),
    abstract: z.string().optional(),
    authors: z.array(z.string()).optional(),
    venue: z.string().optional(),
    year: z.number().nullish(),
    url: z.string().nullish(),
    doi: z.string().nullish(),
    localPath: z.string().nullish(),
  }).optional(),
});

export const SourceAcquisitionRequestSchema = z.object({
  operation: z.enum(["check", "acquire"]).optional(),
  preferred: z.enum(["auto", "pdf", "html"]).optional(),
  sourceUrl: z.string().optional(),
  pdfUrl: z.string().optional(),
  title: z.string().optional(),
  preprintId: z.string().optional(),
  localPath: z.string().optional(),
  htmlSnapshotPath: z.string().optional(),
});

export const RevealLocalFileRequestSchema = z.object({
  kind: z.enum(["pdf", "html"]).optional(),
  path: z.string().optional(),
});

export const StorageManagementRequestSchema = z.object({
  operation: z.enum(["inspect", "clean", "repair", "clean-orphans", "move"]).optional(),
  confirmed: z.boolean().optional(),
  targetDirectory: z.string().optional(),
});

export const DirectoryPickerRequestSchema = z.object({
  target: z.string().optional(),
});

export const ModelSelectionRequestSchema = z.object({
  modelId: z.string().optional(),
});

export const GithubTestRequestSchema = z.object({
  repo: z.string().optional(),
  token: z.string().optional(),
});

// --- Feed ---

/** Renaming and collapsing are independent edits; a request may carry either. */
export const FeedSnippetPatchSchema = z.object({
  title: z.string().optional(),
  collapsed: z.boolean().optional(),
});

export const FeedReplyRequestSchema = z.object({
  reply: z.string().optional(),
  model: z.string().optional(),
});

/** The composer's JSON form (the multipart form is handled separately). */
export const FeedSnippetCreateSchema = z.object({
  instruction: z.string().optional(),
  body: z.string().optional(),
  title: z.string().optional(),
  model: z.string().optional(),
  paperIds: z.array(z.string()).optional(),
});

export const FeedWorkflowRunRequestSchema = z.object({
  script: z.string().optional(),
  args: z.unknown().optional(),
});

export const FeedSkillsRequestSchema = z.object({
  skills: z.unknown().optional(),
});

export const FeedWorkflowsRequestSchema = z.object({
  workflows: z.unknown().optional(),
});

/**
 * A saved workflow as posted by the editor. Only `script` matters: name and
 * description are re-derived from the script's own `meta` block, with these as
 * the fallback, so the stored list always describes what the script really is.
 */
export const IncomingWorkflowSchema = z.object({
  id: z.string().prefault(""),
  name: z.string().optional(),
  description: z.string().optional(),
  script: z.string().prefault(""),
});

/**
 * The metadata object the extraction model is asked to return. Field-level
 * coercion happens in the route's normalizeMetadata (which also supplies the
 * heuristic fallbacks), so this only enforces that the reply is a JSON object at
 * all: a bare string, an array, or prose is refused here instead of yielding an
 * object whose every field reads as undefined.
 */
export const ExtractedMetadataSchema = z.record(z.string(), z.unknown());
