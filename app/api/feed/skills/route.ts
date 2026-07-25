import { readFeedSkills, writeFeedSkills } from "@/app/lib/local-settings";
import { DEFAULT_FEED_SKILLS, normalizeFeedSkills } from "@/app/lib/feed-skills";
import { parseWith } from "@/app/lib/schemas/parse";
import { FeedSkillsRequestSchema } from "@/app/lib/schemas/requests";

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
  const parsed = parseWith(FeedSkillsRequestSchema, await request.json().catch(() => ({})));
  // A malformed body must not overwrite what is saved. normalizeFeedSkills falls
  // back to the seed defaults for a non-array, so without this check a bad request
  // silently replaced the user's own skills with the built-in set.
  if (!parsed.ok || !Array.isArray(parsed.data.skills)) {
    return Response.json({ error: "Send a skills array to save." }, { status: 400 });
  }
  const skills = normalizeFeedSkills(parsed.data.skills);
  writeFeedSkills(skills);
  return Response.json({ skills });
}
