/**
 * Read a human-readable message out of a failed `Response`, falling back to a
 * generic "Request failed with <status>." line. Shared by every client caller
 * that does `throw new Error(await readError(response))`.
 *
 * Uses `||` (not `??`) on the JSON `error` field so an empty-string error still
 * yields the status fallback rather than a blank message.
 */
export async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string; detail?: string };
    if (payload.error && payload.detail) {
      return `${payload.error} ${payload.detail}`;
    }
    return payload.error || `Request failed with ${response.status}.`;
  } catch {
    return `Request failed with ${response.status}.`;
  }
}
