import { readStoredSettings } from "@/app/lib/settings-store";
import { stopFeed } from "@/app/lib/feed-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const settings = await readStoredSettings();
  if (!settings.feedEnabled) {
    return Response.json({ error: "The AI feed is not enabled." }, { status: 403 });
  }
  const { id } = await context.params;
  await stopFeed(id);
  return Response.json({ ok: true });
}
