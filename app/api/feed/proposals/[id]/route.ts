import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";
import { scheduleOutcomeReport } from "@/app/lib/feed-outcomes";
import { applyLibraryMutation } from "@/app/lib/library-mutations";
import { parseJsonWith, parseWith } from "@/app/lib/schemas/parse";
import { ProposalOperationSchema, storedProposalSummary } from "@/app/lib/schemas/proposals";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Approve or reject; anything else (including an absent body) means approve,
 *  matching the UI's default action. */
const ResolveRequestSchema = z.object({
  decision: z.enum(["approve", "reject"]).optional(),
});

/**
 * Put the decision in the thread and hand it to the agent.
 *
 * The thread note is what the user (and the mirrored GitHub issue) sees; the
 * report is what the agent is told, coalesced so a run of approvals is one turn.
 * Both matter: a decision the agent never hears about leaves it believing its
 * proposal is still outstanding.
 */
async function recordDecision(snippetId: string, note: string): Promise<void> {
  const database = await ensureDatabase();
  // The row's "Updated" moves with the decision: it is a change to the thread, and
  // leaving the stamp behind its own newest message is what the status rule reads as a
  // run that outlived its turn.
  database
    .update(feedSnippets)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(feedSnippets.id, snippetId))
    .run();
  database
    .insert(feedMessages)
    .values({
      id: `msg-${crypto.randomUUID()}`,
      snippetId,
      role: "system",
      kind: "text",
      content: note,
      createdAt: new Date().toISOString(),
    })
    .run();
  scheduleOutcomeReport(snippetId);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const raw = await request.json().catch(() => ({}));
  const parsedBody = parseWith(ResolveRequestSchema, raw);
  const decision = parsedBody.ok && parsedBody.data.decision === "reject" ? "reject" : "approve";

  const database = await ensureDatabase();
  const proposal = database.select().from(feedProposals).where(eq(feedProposals.id, id)).get();
  if (!proposal) {
    return Response.json({ error: "Proposal not found." }, { status: 404 });
  }
  if (proposal.status !== "pending") {
    return Response.json({ error: `This proposal was already ${proposal.status}.` }, { status: 409 });
  }

  // Atomically claim the proposal out of "pending" before doing any work, so two
  // concurrent resolves (e.g. the same feed open in two tabs) can't both apply
  // the mutation. Only the request that flips the row proceeds; the loser gets a
  // 409. The claim status also survives a crash mid-apply, so an applied change
  // is never re-armed as pending.
  const claimStatus = decision === "reject" ? "rejected" : "approved";
  const claimed = database
    .update(feedProposals)
    .set({ status: claimStatus, resolvedAt: new Date().toISOString() })
    .where(and(eq(feedProposals.id, id), eq(feedProposals.status, "pending")))
    .run();
  if (claimed.changes === 0) {
    return Response.json({ error: "This proposal was already resolved." }, { status: 409 });
  }

  if (decision === "reject") {
    await recordDecision(proposal.snippetId, `Rejected: ${storedProposalSummary(proposal.operation, "a change")}`);
    return Response.json({ status: "rejected" });
  }

  // Approve: apply the proposed mutation through the shared library mutation
  // path (the same code the library API uses), then record the outcome.
  // Re-validate the stored operation before applying it. It was checked when the
  // agent proposed it, but it has been JSON in a database column since then: a
  // schema change, a manual edit, or a row written by an older version could all
  // put a shape here that no longer matches what the applier expects. Parsing
  // (rather than casting) means such a row fails visibly as this proposal, not
  // as a confusing error from inside the library write.
  const parsed = parseJsonWith(ProposalOperationSchema, proposal.operation);
  if (!parsed.ok) {
    const reason = `The proposal could not be parsed: ${parsed.error}`;
    await recordDecision(proposal.snippetId, `Could not apply: ${reason}`);
    database
      .update(feedProposals)
      .set({ status: "failed", resultSummary: reason, resolvedAt: new Date().toISOString() })
      .where(eq(feedProposals.id, id))
      .run();
    return Response.json({ error: reason }, { status: 400 });
  }
  const operation = parsed.data;

  try {
    const summary = await applyLibraryMutation(operation);
    await recordDecision(proposal.snippetId, `Approved and applied: ${summary}`);
    database
      .update(feedProposals)
      .set({ status: "applied", resultSummary: summary, resolvedAt: new Date().toISOString() })
      .where(eq(feedProposals.id, id))
      .run();
    return Response.json({ status: "applied", summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The change could not be applied.";
    await recordDecision(proposal.snippetId, `Could not apply ${storedProposalSummary(proposal.operation, "a change")}: ${message}`);
    database
      .update(feedProposals)
      .set({ status: "failed", resultSummary: message, resolvedAt: new Date().toISOString() })
      .where(eq(feedProposals.id, id))
      .run();
    return Response.json({ error: message }, { status: 400 });
  }
}
