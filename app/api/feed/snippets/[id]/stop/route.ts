import { stopFeed } from "@/app/lib/feed-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  await stopFeed(id);
  return Response.json({ ok: true });
}
