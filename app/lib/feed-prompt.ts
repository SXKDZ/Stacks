/**
 * Builds the prompt sent to the headless feed agent and parses the library
 * changes it proposes. The agent has no Bash and no API access, so it can never
 * mutate PA directly. Instead, when a task implies library changes, it emits a
 * fenced ```pa-proposals JSON block; PA parses that into proposals the user
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
You cannot run shell commands, and you cannot modify Paper Assistant's library
directly. When the task asks you to add, edit, or remove library records
(papers, authors, venues, collections), DO NOT claim you did it. Instead, at the
END of your reply, emit exactly one fenced code block tagged pa-proposals
containing a JSON array of proposed changes. Each item:
  { "entity": "paper"|"author"|"venue"|"collection",
    "action": "create"|"update"|"delete",
    "id": "<required for update/delete>",
    "data": { ...fields... },
    "summary": "<one short human-readable line describing the change>" }
For a paper, data may include: title, abstract, year, authors (array of names),
venueName, doi, arxivId, url, pdfUrl, collectionNames (array), notes.
Only include the block when there are real changes to propose; omit it otherwise.
The user reviews and approves each proposal before anything is written.`;

export function buildSnippetPrompt(input: { instruction: string; freeText: string }): string {
  const parts: string[] = [
    "You are PA Feed, a research assistant working inside Paper Assistant.",
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
  return parts.join("\n");
}

/** Prompt for a follow-up turn that reports the outcome of approved proposals. */
export function buildFollowUpPrompt(input: {
  reply: string;
  appliedSummaries?: string[];
  rejectedSummaries?: string[];
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
