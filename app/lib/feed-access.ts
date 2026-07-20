import { currentSettings } from "@/app/lib/local-settings";

/** True when the AI feed is enabled in the library settings.json. */
export function feedEnabled(): boolean {
  return Boolean(currentSettings().feedEnabled);
}

/** Returns a 403 Response when the feed is disabled, else null. */
export function requireFeedEnabled(): Response | null {
  if (!feedEnabled()) {
    return Response.json({ error: "The AI feed is not enabled." }, { status: 403 });
  }
  return null;
}
