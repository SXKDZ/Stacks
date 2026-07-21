import { BookmarkPlus, FileText, GitCompare, ListChecks, type LucideIcon, Sparkles, Tag, Wand2, Wrench } from "lucide-react";

/**
 * Feed skills: pickable starting prompts for common tasks. Users can add, edit,
 * remove, and reorder them in Settings → Feed skills; they persist in the
 * library settings.json. Icons are stored by NAME (a stable string) and mapped
 * to a Lucide component through FEED_SKILL_ICONS, so the persisted shape stays
 * JSON-serializable.
 */
export interface FeedSkill {
  id: string;
  label: string;
  icon: string;
  /** The instruction text dropped into the composer when picked. */
  prompt: string;
}

/** The icons a skill can use, keyed by the name stored in settings.json. */
export const FEED_SKILL_ICONS: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  summarize: FileText,
  library: BookmarkPlus,
  list: ListChecks,
  compare: GitCompare,
  tag: Tag,
  wand: Wand2,
  wrench: Wrench,
};

export const DEFAULT_FEED_SKILL_ICON = "sparkles";

/** Resolve a stored icon name to a component, falling back to the default. */
export function feedSkillIcon(name: string): LucideIcon {
  return FEED_SKILL_ICONS[name] ?? FEED_SKILL_ICONS[DEFAULT_FEED_SKILL_ICON];
}

/** The seed skills, used when the user has none saved yet. */
export const DEFAULT_FEED_SKILLS: FeedSkill[] = [
  {
    id: "summarize",
    label: "Summarize",
    icon: "summarize",
    prompt: "Summarize the attached paper (or the link/note above): motivation, method, key results, and how it differs from prior work. Keep it concise.",
  },
  {
    id: "add-to-library",
    label: "Add to library",
    icon: "library",
    prompt: "Fetch this and add it to my library. Pull the title, authors, venue, year, DOI/arXiv id, and abstract, then propose the paper for me to approve.",
  },
  {
    id: "reading-list",
    label: "Reading list",
    icon: "list",
    prompt: "Look through my inbox papers and make a prioritized reading list, grouped by theme, with a one-line reason for each.",
  },
  {
    id: "compare",
    label: "Compare",
    icon: "compare",
    prompt: "Compare the attached papers: what each proposes, where they agree and disagree, and which is stronger for which use case.",
  },
  {
    id: "tag",
    label: "Tag",
    icon: "tag",
    prompt: "Suggest tags for the attached paper (or a set of papers) based on their topics, and propose the tag changes for me to approve.",
  },
  {
    id: "explain",
    label: "Explain",
    icon: "sparkles",
    prompt: "Explain the core idea of the attached paper to me as if I know the field but not this specific work. Define any new terms it introduces.",
  },
];

/** Validate + normalize a skills array coming from settings.json or the API. */
export function normalizeFeedSkills(value: unknown): FeedSkill[] {
  if (!Array.isArray(value)) {
    return DEFAULT_FEED_SKILLS;
  }
  const skills: FeedSkill[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
    const prompt = typeof candidate.prompt === "string" ? candidate.prompt.trim() : "";
    if (!label || !prompt) continue;
    const icon = typeof candidate.icon === "string" && FEED_SKILL_ICONS[candidate.icon]
      ? candidate.icon
      : DEFAULT_FEED_SKILL_ICON;
    const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : `skill-${skills.length}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    skills.push({ id, label: label.slice(0, 60), icon, prompt: prompt.slice(0, 4000) });
  }
  return skills;
}
