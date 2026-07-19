import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * CSRF / cross-origin guard for state-changing API requests. PA is a local
 * single-user server, but its routes have real side effects (writing secrets,
 * downloading remote sources, spawning native dialogs, deleting files). A page
 * on any other origin could POST to them with a simple request, so we require
 * that mutating calls come from PA's own origin.
 *
 * We trust two independent signals:
 *   - Sec-Fetch-Site: `same-origin`/`none` are safe; browsers set this and it
 *     cannot be forged by page script.
 *   - Origin: when present, its host must match the request host.
 * Non-browser callers (curl, native fetch) send neither header and are allowed
 * through — the threat model is a browser on a foreign origin, not local tools.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isSameOrigin(request: NextRequest): boolean {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite) {
    return secFetchSite === "same-origin" || secFetchSite === "none";
  }
  const origin = request.headers.get("origin");
  if (!origin) {
    // No browser origin signals at all → treat as a non-browser client (curl,
    // server-side fetch) rather than a forged cross-site request.
    return true;
  }
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

export function proxy(request: NextRequest): NextResponse {
  if (!SAFE_METHODS.has(request.method) && !isSameOrigin(request)) {
    return NextResponse.json(
      { error: "Cross-origin requests are not allowed." },
      { status: 403 },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
