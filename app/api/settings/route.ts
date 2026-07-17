import {
  readStoredSettings,
  saveStoredSettings,
  settingsSnapshot,
  type SettingsInput,
} from "@/app/lib/settings-store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(settingsSnapshot(await readStoredSettings()));
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json() as { data?: SettingsInput };
    const settings = await saveStoredSettings(body.data ?? {});
    return Response.json(settingsSnapshot(settings));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Settings could not be saved." },
      { status: 400 },
    );
  }
}
