import { GET as libraryGet } from "@/app/api/library/route";
import { ensureDatabase } from "@/db/bootstrap";
import { feedProposals } from "@/db/schema";
import { snippetForToken } from "@/app/lib/feed-token";
import { parseProposals, type ProposalOperation } from "@/app/lib/feed-prompt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Agent-facing library API. The feed agent (via Bash + curl) authenticates with
 * its per-run bearer token. GET returns the live library snapshot (reads are
 * safe, no approval needed). POST enqueues a proposed change tied to the
 * snippet — it never mutates directly; the user approves it in the feed card.
 */

function authSnippet(request: Request): string | null {
  return snippetForToken(request.headers.get("authorization") ?? request.headers.get("x-pa-feed-token"));
}

export async function GET(request: Request): Promise<Response> {
  if (!authSnippet(request)) {
    return Response.json({ error: "Unauthorized: a valid feed token is required." }, { status: 401 });
  }
  // Reuse the library snapshot the app itself uses (papers, authors, venues,
  // collections, stats). Read-only, so it runs live with no approval gate.
  return libraryGet();
}

export async function POST(request: Request): Promise<Response> {
  const snippetId = authSnippet(request);
  if (!snippetId) {
    return Response.json({ error: "Unauthorized: a valid feed token is required." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { proposals?: unknown; operation?: unknown } | null;
  if (!body) {
    return Response.json({ error: "Send a JSON body with a proposal." }, { status: 400 });
  }
  // Accept either a single {entity,action,...} operation or a { proposals: [...] }
  // array, or a raw proposals array; normalize through the parser.
  const source = Array.isArray(body.proposals)
    ? JSON.stringify(body.proposals)
    : body.operation
      ? JSON.stringify([body.operation])
      : JSON.stringify([body]);
  const operations = parseProposals(`\`\`\`stacks-proposals\n${source}\n\`\`\``);
  if (!operations.length) {
    return Response.json({ error: "No valid proposals found. Each needs entity, action, and (for update/delete) id." }, { status: 400 });
  }

  const database = await ensureDatabase();
  const created: Array<{ id: string; summary: string }> = [];
  for (const operation of operations as ProposalOperation[]) {
    const id = `prop-${crypto.randomUUID()}`;
    database
      .insert(feedProposals)
      .values({ id, snippetId, operation: JSON.stringify(operation), status: "pending", createdAt: new Date().toISOString() })
      .run();
    created.push({ id, summary: operation.summary ?? `${operation.action} ${operation.entity}` });
  }
  return Response.json({
    status: "pending_approval",
    message: "Proposed changes are queued for the user to approve; they are NOT applied yet.",
    proposals: created,
  });
}
