import { POST as libraryPost } from "@/app/api/library/route";
import type { ProposalOperation } from "@/app/lib/feed-prompt";

/**
 * Apply an approved feed proposal through the exact same code path the library
 * API uses — by invoking the library route's POST handler with an equivalent
 * request. This guarantees proposals go through the same validation, metadata
 * normalization, dedup, and drizzle transaction as any other library write, so
 * there is no second mutation implementation to keep in sync. Returns a short
 * human-readable summary; throws with the API's error message on failure.
 */
export async function applyLibraryMutation(operation: ProposalOperation): Promise<string> {
  const body = {
    entity: operation.entity,
    action: operation.action,
    ...(operation.id ? { id: operation.id } : {}),
    ...(operation.data ? { data: operation.data } : {}),
  };
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
  return operation.summary ?? `${operation.action} ${operation.entity}`;
}
