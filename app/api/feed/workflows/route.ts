import { readFeedWorkflows, writeFeedWorkflows } from "@/app/lib/local-settings";
import { DEFAULT_FEED_WORKFLOWS, normalizeFeedWorkflows } from "@/app/lib/feed-workflows";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The pickable feed workflows: the user's saved set, or the seed defaults. */
export async function GET(): Promise<Response> {
  const saved = readFeedWorkflows();
  const workflows = saved === undefined ? DEFAULT_FEED_WORKFLOWS : normalizeFeedWorkflows(saved);
  return Response.json({ workflows });
}

/** Replace the saved workflows with the posted set (validated + normalized). */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { workflows?: unknown };
  const workflows = normalizeFeedWorkflows(body.workflows);
  writeFeedWorkflows(workflows);
  return Response.json({ workflows });
}
