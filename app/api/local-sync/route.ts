import { z } from "zod";

import { currentSettings, persistSettings, runSync } from "@/app/lib/local-settings";
import { parseWith } from "@/app/lib/schemas/parse";
import { SettingsPayloadSchema } from "@/app/lib/schemas/settings";

/** Sync may carry a settings patch to save before running. */
const SyncRequestSchema = z.object({ data: SettingsPayloadSchema.optional() });

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = parseWith(SyncRequestSchema, await request.json().catch(() => ({})));
    if (!parsed.ok) {
      return Response.json({ error: parsed.error, sync: currentSettings().sync }, { status: 400 });
    }
    if (parsed.data.data) {
      persistSettings(parsed.data.data);
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
