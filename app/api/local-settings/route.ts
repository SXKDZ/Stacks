import { currentSettings, persistSettings, scheduleAutoSync, type SettingsPayload } from "@/app/lib/local-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    return Response.json(currentSettings());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Settings could not be loaded." },
      { status: 400 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({})) as { data?: SettingsPayload };
    const wasAutoSync = currentSettings().sync.autoSync;
    persistSettings((body.data ?? {}) as SettingsPayload);
    // Turning auto-back up ON should produce a backup right away rather than
    // waiting for the next library edit, so the status stops reading "never
    // synced" the moment the user enables it.
    if (!wasAutoSync && currentSettings().sync.autoSync) {
      scheduleAutoSync();
    }
    return Response.json(currentSettings());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Settings could not be saved." },
      { status: 400 },
    );
  }
}
