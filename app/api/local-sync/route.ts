import { currentSettings, persistSettings, runSync, type SettingsPayload } from "@/app/lib/local-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({})) as { data?: SettingsPayload };
    if (body.data && typeof body.data === "object") {
      persistSettings(body.data as SettingsPayload);
    }
    const result = await runSync(false);
    return Response.json({ result, sync: currentSettings().sync }, { status: result.ok ? 200 : 502 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Sync failed.", sync: currentSettings().sync },
      { status: 502 },
    );
  }
}
