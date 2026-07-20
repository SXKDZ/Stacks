import { eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";
import { requireFeedEnabled } from "@/app/lib/feed-access";
import { isFeedRunning, runFeedAgent } from "@/app/lib/feed-agent";
import { buildFollowUpPrompt } from "@/app/lib/feed-prompt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ReplyRequest {
  reply?: string;
}

function proposalSummary(operation: string): string {
  try {
    return (JSON.parse(operation) as { summary?: string }).summary ?? "a change";
  } catch {
    return "a change";
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const blocked = requireFeedEnabled();
  if (blocked) {
    return blocked;
  }
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as ReplyRequest;
  const reply = body.reply?.trim() ?? "";

  const database = await ensureDatabase();
  const snippet = database.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();
  if (!snippet) {
    return Response.json({ error: "Snippet not found." }, { status: 404 });
  }
  if (!snippet.sessionId) {
    return Response.json({ error: "This snippet has no resumable session yet." }, { status: 409 });
  }
  if (isFeedRunning(id)) {
    return Response.json({ error: "The agent is still working on this snippet." }, { status: 409 });
  }
  if (!reply) {
    return Response.json({ error: "Enter a follow-up message." }, { status: 400 });
  }

  // Report the outcomes of proposals the user resolved since the last turn so
  // the agent knows what was applied or rejected, then continue the thread.
  const proposals = database.select().from(feedProposals).where(eq(feedProposals.snippetId, id)).all();
  const appliedSummaries = proposals.filter((p) => p.status === "applied").map((p) => proposalSummary(p.operation));
  const rejectedSummaries = proposals.filter((p) => p.status === "rejected").map((p) => proposalSummary(p.operation));

  database
    .insert(feedMessages)
    .values({ id: `msg-${crypto.randomUUID()}`, snippetId: id, role: "user", kind: "text", content: reply, createdAt: new Date().toISOString() })
    .run();

  const prompt = buildFollowUpPrompt({ reply, appliedSummaries, rejectedSummaries });
  void runFeedAgent({ snippetId: id, sessionId: snippet.sessionId, prompt, resume: true }).catch(() => {});

  return Response.json({ ok: true });
}
