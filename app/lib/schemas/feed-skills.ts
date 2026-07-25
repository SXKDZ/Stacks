/**
 * Feed-skill validation, kept apart from app/lib/feed-skills.ts because that
 * module imports Lucide icon components: a route that only needs to validate a
 * posted skill list shouldn't pull React components into the server bundle.
 *
 * Skills arrive from settings.json or from the Settings form, and both are
 * tolerant boundaries by design: a skill missing an id gets one derived from its
 * label, an unknown icon name falls back to the default, and text is trimmed and
 * capped. That coercion is expressed as schema transforms so the accepted shape
 * and the normalization live together instead of in a hand-written loop.
 */
import { z } from "zod";

/** Longest label and prompt we store, so a paste can't bloat settings.json. */
const MAX_LABEL = 60;
const MAX_PROMPT = 4000;

/**
 * One skill as it may arrive: only label and prompt are required (a skill
 * without either is meaningless and gets dropped by the list schema below).
 * `icon` and `id` are filled in during transform.
 */
const IncomingSkillSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  icon: z.string().optional(),
  prompt: z.string(),
});

export interface NormalizedSkill {
  id: string;
  label: string;
  icon: string;
  prompt: string;
}

/** Slug used when a skill arrives without a usable id. */
function derivedId(label: string, index: number): string {
  return `skill-${index}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/**
 * Validate and normalize a skills list. `knownIcon` decides whether a stored
 * icon name still resolves, injected by the caller so this module stays free of
 * the icon map (and therefore of React).
 *
 * Entries that can't be salvaged (not an object, or empty label/prompt) are
 * skipped rather than failing the whole list: one bad row in settings.json
 * shouldn't cost the user every other skill they configured.
 */
export function normalizeSkillList(
  value: unknown,
  knownIcon: (name: string) => boolean,
  defaultIcon: string,
): NormalizedSkill[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const skills: NormalizedSkill[] = [];
  for (const item of value) {
    const parsed = IncomingSkillSchema.safeParse(item);
    if (!parsed.success) {
      continue;
    }
    const label = parsed.data.label.trim();
    const prompt = parsed.data.prompt.trim();
    if (!label || !prompt) {
      continue;
    }
    const icon = parsed.data.icon && knownIcon(parsed.data.icon) ? parsed.data.icon : defaultIcon;
    const id = parsed.data.id?.trim() || derivedId(label, skills.length);
    skills.push({ id, label: label.slice(0, MAX_LABEL), icon, prompt: prompt.slice(0, MAX_PROMPT) });
  }
  return skills;
}
