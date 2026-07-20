import { currentSettings, persistSettings, type SettingsPayload } from "@/app/lib/local-settings";

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
    persistSettings((body.data ?? {}) as SettingsPayload);
    return Response.json(currentSettings());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Settings could not be saved." },
      { status: 400 },
    );
  }
}
