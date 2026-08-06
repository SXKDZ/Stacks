/**
 * Builds the prompt sent to the headless feed agent and parses the library
 * changes it proposes. The agent has no Bash and no API access, so it can never
 * mutate the Stacks library directly. Instead, when a task implies library changes, it emits a
 * fenced ```stacks-proposals JSON block; Stacks parses that into proposals the
 * user approves or rejects. Approved proposals are applied through the library route.
 */

import { parseProposalBatch, type ProposalOperation } from "@/app/lib/schemas/proposals";
import type { SnippetAttachment } from "@/app/lib/schemas/attachments";

// The operation shape is defined once as a Zod schema and the type is derived
// from it, so the runtime contract and the compile-time type cannot drift.
export type { ProposalOperation };

const PAPER_SCOPE_RULES = `
- Scope every read to the user's request. If the user asks to read, summarize,
  or analyze one identified paper, retrieve only that paper from its supplied
  identifier, URL, or attachment. Do NOT call the full-library endpoint.
- For an attached library paper, use the paper-specific metadata and file URLs
  documented with the attachment; never load the whole library to read it.
- Call the full-library endpoint only when library-wide state is necessary for
  the requested task. A one-paper reading task is never a reason to inspect the
  rest of the collection.
- Before proposing a library change, check only the state needed to make that
  proposal safe. A create may use the full-library read for duplicate detection.
- Verify the complete ordered author list from a reliable source before proposing
  a paper create. If it cannot be verified, explain what is missing and do not
  queue an incomplete create proposal. Never invent an author.
- For an arXiv preprint proposal, set both venueName and venueAcronym to "arXiv".`;

const PROPOSAL_INSTRUCTIONS = `
You can query and edit the user's Stacks library through a local HTTP
API, using the Bash tool with curl. The base URL and an auth token are in your
environment as $STACKS_FEED_BASE_URL and $STACKS_FEED_TOKEN.

FULL LIBRARY READ (runs immediately; use only when the request genuinely needs
library-wide state, such as cross-library comparison, discovery, counts,
collection-wide analysis, or a duplicate check before proposing a change):
  curl -s -H "Authorization: Bearer $STACKS_FEED_TOKEN" "$STACKS_FEED_BASE_URL/api/feed/library"
Returns JSON: { papers[], authors[], venues[], collections[], stats }. Each
paper has id, title, doi, arxivId, year, authors[], collections[], etc.

WRITE (does NOT apply immediately: it QUEUES a proposal the user must approve):
  curl -s -X POST -H "Authorization: Bearer $STACKS_FEED_TOKEN" \\
    -H "Content-Type: application/json" \\
    -d '{"operation":{"entity":"paper","action":"create","data":{...},"summary":"..."}}' \\
    "$STACKS_FEED_BASE_URL/api/feed/library"
Or send several at once: {"proposals":[{...},{...}]}. Each operation:
  { "entity": "paper"|"author"|"venue"|"collection",
    "action": "create"|"update"|"delete",
    "id": "<required for update/delete>",
    "data": { ...fields... },
    "summary": "<one short human-readable line describing the change>" }
For a paper create, data MUST include title, paperType, and the complete verified
authors array in the source's listed order. Include every other verified field:
abstract, year, venueName, venueAcronym, doi, arxivId, url, pdfUrl,
collectionNames (array), and notes. Never silently omit known metadata.
- paperType is REQUIRED on every create and MUST be one of: "conference",
  "journal", "workshop", "preprint", or "other". Never omit it. Choose the most
  specific fit (an arXiv-only paper is "preprint"; a blog post or tech report
  with no venue is "other").
- Always set venueName when the work has one (conference/journal/repository name;
  drop "Proceedings of" and ordinals), and venueAcronym when there is a common
  one. Leave venueName empty only for genuinely un-venued items such as
  standalone reports or personal blog posts.

RULES:
${PAPER_SCOPE_RULES}
- Never claim a change was applied: writes only queue a proposal for approval.
- Only propose changes the user actually asked for.
- Fill paperType and venue for every paper you add; don't leave them blank/"other" out of laziness.
- If curl is unavailable for any reason, fall back to emitting one fenced
  stacks-proposals block (a JSON array of the operations above) at the end of
  your reply, and Stacks will pick it up.`;

function describeAttachments(attachments: SnippetAttachment[]): string {
  // Uploads live in the working directory (read by relative path). Library
  // papers are referenced by id, not copied in: the agent fetches the original
  // from the read-only file API into /tmp and reads that. (paper-pdf/paper-html
  // are legacy staged copies from older feeds; still read by relative path.)
  const uploads = attachments.filter((a) => a.kind === "upload" || a.kind === "paper-pdf" || a.kind === "paper-html");
  const papers = attachments.filter((a) => a.kind === "paper" && a.paperId);
  const lines: string[] = [];
  if (uploads.length) {
    lines.push(
      "Attached files are in your working directory. Read them directly (paths are",
      "relative to your current directory) to ground your work:",
      ...uploads.map((a) => `- ${a.relativePath}: ${a.label}`),
    );
  }
  if (papers.length) {
    if (lines.length) lines.push("");
    lines.push(
      "Attached library papers (read the ORIGINAL, do not re-add them). For each,",
      "fetch its metadata and file with your feed token:",
      ...papers.map((a) => `- paper ${a.paperId}: ${a.label}`),
      "  Metadata (returns the paper's fields, plus hasFile and fileUrl):",
      "    curl -s -H \"Authorization: Bearer $STACKS_FEED_TOKEN\" \\",
      "      \"$STACKS_FEED_BASE_URL/api/feed/library/papers/<id>\"",
      "  File (when hasFile is true): download the PDF/HTML into /tmp and read it:",
      "    curl -s -H \"Authorization: Bearer $STACKS_FEED_TOKEN\" \\",
      "      \"$STACKS_FEED_BASE_URL/api/feed/library/papers/<id>/file\" -o /tmp/<id>.pdf",
      "  then Read /tmp/<id>.pdf. If hasFile is false, use the paper's url/pdfUrl.",
    );
  }
  return lines.join("\n");
}

export function buildSnippetPrompt(input: {
  instruction: string;
  freeText: string;
  attachments?: SnippetAttachment[];
}): string {
  const parts: string[] = [
    "You are the Stacks AI feed agent, working inside the Stacks research library app.",
    "The user captured the following into their feed. Do what they ask, concisely.",
    PROPOSAL_INSTRUCTIONS,
    "",
  ];
  if (input.instruction) {
    parts.push(`Instruction:\n${input.instruction}`);
  }
  if (input.freeText && input.freeText !== input.instruction) {
    parts.push(`\nCaptured content:\n${input.freeText}`);
  }
  if (input.attachments?.length) {
    parts.push(`\n${describeAttachments(input.attachments)}`);
  }
  return parts.join("\n");
}

/** Prompt for a follow-up turn that reports the outcome of approved proposals. */
export function buildFollowUpPrompt(input: {
  reply: string;
  appliedSummaries?: string[];
  rejectedSummaries?: string[];
  attachments?: SnippetAttachment[];
}): string {
  const parts: string[] = [
    "Apply these rules to this turn even if earlier session context says otherwise:",
    PAPER_SCOPE_RULES,
  ];
  if (input.appliedSummaries?.length) {
    parts.push(`The user APPROVED and applied these changes:\n- ${input.appliedSummaries.join("\n- ")}`);
  }
  if (input.rejectedSummaries?.length) {
    parts.push(`The user REJECTED these proposals (do not retry them unless asked):\n- ${input.rejectedSummaries.join("\n- ")}`);
  }
  if (input.reply.trim()) {
    parts.push(`\n${input.reply.trim()}`);
  }
  if (input.attachments?.length) {
    parts.push(`\n${describeAttachments(input.attachments)}`);
  }
  parts.push("\nContinue. Use the same stacks-proposals block format for any new changes.");
  return parts.join("\n");
}

/**
 * Prompt for the first turn of a FORKED thread. The fork runs in a fresh agent
 * session, so it has no built-in memory of the parent conversation; we seed it
 * with a transcript of the copied history, then the user's new message.
 */
export function buildForkPrompt(input: {
  reply: string;
  transcript: string;
  attachments?: SnippetAttachment[];
}): string {
  const parts: string[] = [
    "You are the Stacks AI feed agent. This is a forked continuation of an earlier",
    "conversation. Here is the transcript so far, for context:",
    "",
    input.transcript,
    "",
    PROPOSAL_INSTRUCTIONS,
    "",
    "The user now continues the conversation:",
  ];
  if (input.reply.trim()) {
    parts.push(input.reply.trim());
  }
  if (input.attachments?.length) {
    parts.push(`\n${describeAttachments(input.attachments)}`);
  }
  return parts.join("\n");
}

/**
 * Locate the proposal JSON in an assistant result: the last ```stacks-proposals
 * block (accepting the legacy ```pa-proposals label too), falling back to a
 * plain ```json block that holds an array.
 */
function proposalBlock(text: string): string {
  const blocks = [...text.matchAll(/```(?:stacks|pa)-proposals\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  let raw = blocks.length ? blocks[blocks.length - 1] : "";
  if (!raw) {
    for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
      const candidate = match[1].trim();
      if (candidate.startsWith("[")) {
        raw = candidate;
      }
    }
  }
  return raw.trim();
}

/**
 * Extract proposals from an assistant result, reporting what failed.
 *
 * Validation is the shared Zod contract (app/lib/schemas/proposals.ts), so the
 * rules for what an operation may contain live in one place instead of being
 * re-implemented here. Malformed entries are returned as `errors` rather than
 * dropped silently, which is what the previous hand-written loop did: an agent
 * that emitted a proposal with a typo'd action or a stray field saw it vanish
 * with no explanation anywhere.
 */
export function parseProposalsResult(text: string): { operations: ProposalOperation[]; errors: string[] } {
  const raw = proposalBlock(text);
  if (!raw) {
    return { operations: [], errors: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { operations: [], errors: [error instanceof Error ? error.message : "The proposal block is not valid JSON."] };
  }
  return parseProposalBatch(parsed);
}
