/**
 * Builds the prompt sent to the headless feed agent and parses the library
 * changes it proposes. The agent has no Bash and no API access, so it can never
 * mutate the Stacks library directly. Instead, when a task implies library changes, it emits a
 * fenced ```pa-proposals JSON block; Stacks parses that into proposals the user
 * approves or rejects. Approved proposals are applied through the library route.
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

READ (runs immediately — use this to answer questions like "is this already in
my library?", to look up ids, counts, collections, etc.):
  curl -s -H "Authorization: Bearer $STACKS_FEED_TOKEN" "$STACKS_FEED_BASE_URL/api/feed/library"
Returns JSON: { papers[], authors[], venues[], collections[], stats }. Each
paper has id, title, doi, arxivId, year, authors[], collections[], etc.

WRITE (does NOT apply immediately — it QUEUES a proposal the user must approve):
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
For a paper, data may include: title, abstract, year, authors (array of names),
venueName, doi, arxivId, url, pdfUrl, collectionNames (array), notes.

RULES:
- Always READ first to check current state before proposing changes.
- Never claim a change was applied — writes only queue a proposal for approval.
- Only propose changes the user actually asked for.
- If curl is unavailable for any reason, fall back to emitting one fenced
  pa-proposals block (a JSON array of the operations above) at the end of your
  reply, and Stacks will pick it up.`;

interface SnippetAttachment {
  relativePath: string;
  label: string;
  kind: "paper-pdf" | "paper-html" | "upload";
}

function describeAttachments(attachments: SnippetAttachment[]): string {
  const lines = attachments.map((attachment) => {
    const origin = attachment.kind === "paper-pdf"
      ? "library paper (PDF)"
      : attachment.kind === "paper-html"
        ? "library paper (HTML snapshot)"
        : "uploaded file";
    return `- ${attachment.relativePath} — ${attachment.label} (${origin})`;
  });
  return [
    "Attached files are in your working directory. Read them directly (they are",
    "relative to your current directory) to ground your work:",
    ...lines,
  ].join("\n");
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
  parts.push("\nContinue. Use the same pa-proposals block format for any new changes.");
  return parts.join("\n");
}

/**
 * Extract proposals from an assistant result. Reads the last ```pa-proposals
 * block; tolerates a plain ```json block that is an array of ops as a fallback.
 * Returns validated operations only.
 */
export function parseProposals(text: string): ProposalOperation[] {
  const blocks = [...text.matchAll(/```pa-proposals\s*([\s\S]*?)```/gi)].map((match) => match[1]);
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
