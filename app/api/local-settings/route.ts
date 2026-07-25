import { z } from "zod";

import { currentSettings, persistSettings, scheduleAutoSync } from "@/app/lib/local-settings";
import { parseRequest } from "@/app/lib/schemas/parse";
import { SettingsPayloadSchema } from "@/app/lib/schemas/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The settings form posts its fields under `data`. */
const SettingsRequestSchema = z.object({
  data: SettingsPayloadSchema.prefault({}),
});

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
    // Validate before writing: an unknown or wrong-typed field is rejected here
    // rather than persisted into settings.json for a later read to trip over.
    const parsed = await parseRequest(SettingsRequestSchema, request);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    const wasAutoSync = currentSettings().sync.autoSync;
    persistSettings(parsed.data.data);
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
