import { POST as libraryPost } from "@/app/api/library/route";
import { proposalSummary, type ProposalOperation } from "@/app/lib/schemas/proposals";

/**
 * Apply an approved feed proposal through the exact same code path the library
 * API uses — by invoking the library route's POST handler with an equivalent
 * request. This guarantees proposals go through the same validation, metadata
 * normalization, dedup, and drizzle transaction as any other library write, so
 * there is no second mutation implementation to keep in sync. Returns a short
 * human-readable summary; throws with the API's error message on failure.
 */
export async function applyLibraryMutation(operation: ProposalOperation): Promise<string> {
  // Each branch carries exactly the fields its action allows (the proposal
  // schema is a discriminated union on `action`), so this reads them per-branch
  // instead of spreading whatever happens to be present.
  const body = operation.action === "delete"
    ? { entity: operation.entity, action: operation.action, id: operation.id }
    : operation.action === "update"
      ? { entity: operation.entity, action: operation.action, id: operation.id, data: operation.data }
      : { entity: operation.entity, action: operation.action, data: operation.data };
  const request = new Request("http://127.0.0.1/api/library", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await libraryPost(request);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `The library change failed (${response.status}).`);
  }
  return proposalSummary(operation);
}
