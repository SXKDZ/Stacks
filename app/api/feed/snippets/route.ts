import { desc } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedSnippets } from "@/db/schema";
import { runFeedAgent } from "@/app/lib/feed-agent";
import { buildSnippetPrompt } from "@/app/lib/feed-prompt";
import { requireFeedEnabled } from "@/app/lib/feed-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CreateSnippetRequest {
  instruction?: string;
  body?: string;
  title?: string;
}

export async function GET(): Promise<Response> {
  const blocked = requireFeedEnabled();
  if (blocked) {
    return blocked;
  }
  const database = await ensureDatabase();
  const rows = database
    .select()
    .from(feedSnippets)
    .orderBy(desc(feedSnippets.updatedAt))
    .all();
  return Response.json({ snippets: rows });
}

export async function POST(request: Request): Promise<Response> {
  const blocked = requireFeedEnabled();
  if (blocked) {
    return blocked;
  }
  try {
    const body = (await request.json()) as CreateSnippetRequest;
    const instruction = body.instruction?.trim() ?? "";
    const freeText = body.body?.trim() ?? "";
    if (!instruction && !freeText) {
      return Response.json({ error: "Enter an instruction or some text for the agent." }, { status: 400 });
    }
    const database = await ensureDatabase();
    const id = `feed-${crypto.randomUUID()}`;
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = (body.title?.trim() || instruction || freeText).slice(0, 120);
    database
      .insert(feedSnippets)
      .values({
        id,
        title,
        instruction: instruction || freeText,
        status: "queued",
        sessionId: "",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const prompt = buildSnippetPrompt({ instruction, freeText });
    // Fire-and-forget: the agent streams events into feed_messages and SSE.
    void runFeedAgent({ snippetId: id, sessionId, prompt, resume: false }).catch(() => {});

    return Response.json({ id });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The snippet could not be created." },
      { status: 400 },
    );
  }
}
