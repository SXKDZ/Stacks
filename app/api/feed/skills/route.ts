import { readFeedSkills, writeFeedSkills } from "@/app/lib/local-settings";
import { DEFAULT_FEED_SKILLS, normalizeFeedSkills } from "@/app/lib/feed-skills";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The pickable feed skills: the user's saved set, or the seed defaults. */
export async function GET(): Promise<Response> {
  const saved = readFeedSkills();
  const skills = saved === undefined ? DEFAULT_FEED_SKILLS : normalizeFeedSkills(saved);
  return Response.json({ skills });
}

/** Replace the saved skills with the posted set (validated + normalized). */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { skills?: unknown };
  const skills = normalizeFeedSkills(body.skills);
  writeFeedSkills(skills);
  return Response.json({ skills });
}
