/**
 * Builds the prompt sent to the headless feed agent and parses the library
 * changes it proposes. The agent has no Bash and no API access, so it can never
 * mutate the Stacks library directly. Instead, when a task implies library changes, it emits a
 * fenced ```stacks-proposals JSON block; Stacks parses that into proposals the
 * user approves or rejects. Approved proposals are applied through the library route.
 */

export interface ProposalOperation {
  entity: "paper" | "author" | "venue" | "collection";
  action: "create" | "update" | "delete";
  id?: string;
  data?: Record<string, unknown>;
  summary?: string;
}

const PROPOSAL_INSTRUCTIONS = `
You can query and edit the user's Stacks library through a local HTTP
API, using the Bash tool with curl. The base URL and an auth token are in your
environment as $STACKS_FEED_BASE_URL and $STACKS_FEED_TOKEN.

READ (runs immediately: use this to answer questions like "is this already in
my library?", to look up ids, counts, collections, etc.):
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
For a paper, data MUST include title and paperType, and should include: abstract,
year, authors (array of names), venueName, venueAcronym, doi, arxivId, url,
pdfUrl, collectionNames (array), notes.
- paperType is REQUIRED on every create and MUST be one of: "conference",
  "journal", "workshop", "preprint", or "other". Never omit it. Choose the most
  specific fit (an arXiv-only paper is "preprint"; a blog post or tech report
  with no venue is "other").
- Always set venueName when the work has one (conference/journal name; drop
  "Proceedings of" and ordinals, e.g. "NeurIPS", "Nature Machine Intelligence"),
  and venueAcronym when there's a common one. Leave venueName empty only for
  genuinely un-venued items (blog posts, standalone reports).

RULES:
- Always READ first to check current state before proposing changes.
- Never claim a change was applied: writes only queue a proposal for approval.
- Only propose changes the user actually asked for.
- Fill paperType and venue for every paper you add; don't leave them blank/"other" out of laziness.
- If curl is unavailable for any reason, fall back to emitting one fenced
  stacks-proposals block (a JSON array of the operations above) at the end of
  your reply, and Stacks will pick it up.`;

interface SnippetAttachment {
  kind: "upload" | "paper" | "paper-pdf" | "paper-html";
  label: string;
  relativePath?: string;
  paperId?: string;
}

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
  const parts: string[] = [];
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
 * Extract proposals from an assistant result. Reads the last ```stacks-proposals
 * block (accepting the legacy ```pa-proposals label too); tolerates a plain
 * ```json block that is an array of ops as a fallback. Returns validated
 * operations only.
 */
export function parseProposals(text: string): ProposalOperation[] {
  const blocks = [...text.matchAll(/```(?:stacks|pa)-proposals\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  let raw = blocks.length ? blocks[blocks.length - 1] : "";
  if (!raw) {
    // Fallback: a fenced json block whose content parses to an array of ops.
    for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
      const candidate = match[1].trim();
      if (candidate.startsWith("[")) {
        raw = candidate;
      }
    }
  }
  if (!raw.trim()) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const entities = new Set(["paper", "author", "venue", "collection"]);
  const actions = new Set(["create", "update", "delete"]);
  const operations: ProposalOperation[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const entity = candidate.entity;
    const action = candidate.action;
    if (typeof entity !== "string" || !entities.has(entity)) continue;
    if (typeof action !== "string" || !actions.has(action)) continue;
    if ((action === "update" || action === "delete") && typeof candidate.id !== "string") continue;
    operations.push({
      entity: entity as ProposalOperation["entity"],
      action: action as ProposalOperation["action"],
      id: typeof candidate.id === "string" ? candidate.id : undefined,
      data: candidate.data && typeof candidate.data === "object" ? (candidate.data as Record<string, unknown>) : undefined,
      summary: typeof candidate.summary === "string" ? candidate.summary : `${action} ${entity}`,
    });
  }
  return operations;
}
