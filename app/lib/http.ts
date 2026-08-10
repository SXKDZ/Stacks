/**
 * Read a human-readable message out of a failed `Response`, falling back to a
 * generic "Request failed with <status>." line. Shared by every client caller
 * that does `throw new Error(await readError(response))`.
 *
 * Uses `||` (not `??`) on the JSON `error` field so an empty-string error still
 * yields the status fallback rather than a blank message.
 */
export interface HttpErrorInfo {
  summary: string;
  details: string;
}

/** Read both the concise recovery message and optional diagnostics supplied by
 * an API route. Callers with an expandable error surface should use this. */
export async function readErrorInfo(response: Response): Promise<HttpErrorInfo> {
  try {
    const payload = (await response.json()) as { error?: string; details?: string };
    return {
      summary: payload.error || `Request failed with ${response.status}.`,
      details: typeof payload.details === "string" ? payload.details.trim() : "",
    };
  } catch {
    return { summary: `Request failed with ${response.status}.`, details: "" };
  }
}

export async function readError(response: Response): Promise<string> {
  return (await readErrorInfo(response)).summary;
}
