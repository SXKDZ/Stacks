/**
 * Next.js server-start hook. Runs once when the Node server boots — used to
 * start the feed workflow scheduler (recurring workflows auto-run here, on the
 * always-on local server, even with no browser tab open).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startFeedScheduler } = await import("@/app/lib/feed-scheduler");
    startFeedScheduler();
  }
}
