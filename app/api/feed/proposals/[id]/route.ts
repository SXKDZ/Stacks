import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedProposals } from "@/db/schema";
import { applyLibraryMutation } from "@/app/lib/library-mutations";
import type { ProposalOperation } from "@/app/lib/feed-prompt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ResolveRequest {
  decision?: "approve" | "reject";
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as ResolveRequest;
  const decision = body.decision === "reject" ? "reject" : "approve";

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
    return Response.json({ status: "rejected" });
  }

  // Approve: apply the proposed mutation through the shared library mutation
  // path (the same code the library API uses), then record the outcome.
  let operation: ProposalOperation;
  try {
    operation = JSON.parse(proposal.operation) as ProposalOperation;
  } catch {
    database
      .update(feedProposals)
      .set({ status: "failed", resultSummary: "The proposal could not be parsed.", resolvedAt: new Date().toISOString() })
      .where(eq(feedProposals.id, id))
      .run();
    return Response.json({ error: "The proposal could not be parsed." }, { status: 400 });
  }

  try {
    const summary = await applyLibraryMutation(operation);
    database
      .update(feedProposals)
      .set({ status: "applied", resultSummary: summary, resolvedAt: new Date().toISOString() })
      .where(eq(feedProposals.id, id))
      .run();
    return Response.json({ status: "applied", summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The change could not be applied.";
    database
      .update(feedProposals)
      .set({ status: "failed", resultSummary: message, resolvedAt: new Date().toISOString() })
      .where(eq(feedProposals.id, id))
      .run();
    return Response.json({ error: message }, { status: 400 });
  }
}
