import { randomBytes } from "node:crypto";

/**
 * Per-run bearer tokens for the feed agent. Each running snippet's headless
 * agent gets a short-lived token (in its env) that authorizes calls to the
 * agent-facing library APIs. Only a live agent process holds a valid token, so
 * a browser or other origin cannot drive those endpoints. Tokens are held in
 * memory and revoked when the run ends.
 */

const tokenToSnippet = new Map<string, string>();
const snippetToToken = new Map<string, string>();

export function issueFeedToken(snippetId: string): string {
  revokeFeedToken(snippetId);
  const token = randomBytes(24).toString("hex");
  tokenToSnippet.set(token, snippetId);
  snippetToToken.set(snippetId, token);
  return token;
}

export function revokeFeedToken(snippetId: string): void {
  const existing = snippetToToken.get(snippetId);
  if (existing) {
    tokenToSnippet.delete(existing);
    snippetToToken.delete(snippetId);
  }
}

/** Resolve the snippet id for a request's bearer token, or null if invalid. */
export function snippetForToken(header: string | null): string | null {
  if (!header) {
    return null;
  }
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token ? tokenToSnippet.get(token) ?? null : null;
}
