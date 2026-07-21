import { BookmarkPlus, BookOpen, Brain, FileSearch, FileText, FlaskConical, GitCompare, Highlighter, Languages, Lightbulb, ListChecks, type LucideIcon, MessageSquareText, NotebookPen, Quote, Scale, Sigma, Sparkles, Tag, Telescope, Wand2, Wrench } from "lucide-react";

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
  read: BookOpen,
  brain: Brain,
  search: FileSearch,
  experiment: FlaskConical,
  highlight: Highlighter,
  translate: Languages,
  idea: Lightbulb,
  discuss: MessageSquareText,
  note: NotebookPen,
  quote: Quote,
  weigh: Scale,
  math: Sigma,
  explore: Telescope,
};

export const DEFAULT_FEED_SKILL_ICON = "sparkles";

/** Resolve a stored icon name to a component, falling back to the default. */
export function feedSkillIcon(name: string): LucideIcon {
  return FEED_SKILL_ICONS[name] ?? FEED_SKILL_ICONS[DEFAULT_FEED_SKILL_ICON];
}

/** The seed skills, used when the user has none saved yet. Prompts are written
 *  in the thorough, section-by-section, anti-hallucination style of PaperCLI. */
export const DEFAULT_FEED_SKILLS: FeedSkill[] = [
  {
    id: "summarize",
    label: "Summarize",
    icon: "summarize",
    prompt: [
      "You are an expert academic paper reviewer. Read the attached paper (or the link/note above) and write a careful technical summary.",
      "Only include information explicitly present in the source. Never hallucinate, infer unreported results, or fill gaps; if a section does not apply (e.g. a theory paper has no experiments) say so directly.",
      "Use these sections as GitHub-flavored Markdown headings:",
      "## Motivation — the problem or knowledge gap that motivated the work.",
      "## Objective — the core idea or hypothesis, in accessible language.",
      "## Technical approach — the methods, models, and procedure in real detail.",
      "## Distinctive features — what the authors explicitly present as new vs. prior work.",
      "## Results — the design, data, baselines, metrics, and reported findings (or \"Not applicable — theoretical work\").",
      "## Strengths and limitations — reported strengths separated from stated limitations and open questions.",
      "Preserve math with $...$ and $$...$$. Do not propose any library changes for this task.",
    ].join("\n"),
  },
  {
    id: "add-to-library",
    label: "Add to library",
    icon: "library",
    prompt: [
      "Add the paper(s) above to my library. First READ my library to check whether each is already present (match on DOI, arXiv id, or a close title match) and skip duplicates — tell me which you skipped and why.",
      "For each new paper, fetch authoritative metadata: exact title, the full ordered author list, venue (full name + common acronym), year, DOI, arXiv id, and the abstract. Normalize the venue (drop \"Proceedings of\" and ordinals; use the common conference acronym or ISO-4 journal abbreviation).",
      "Then propose each paper as a library change for me to approve — do not claim anything was added; approval applies it.",
    ].join("\n"),
  },
  {
    id: "reading-list",
    label: "Reading list",
    icon: "list",
    prompt: [
      "Build a prioritized reading list from my library. READ the library first (focus on inbox / unread papers unless I say otherwise).",
      "Group the papers by theme, and within each theme order them by what to read first. For every paper give a one-line reason it earns its place and how it connects to the others.",
      "Call out any prerequisites (read X before Y) and flag papers that look foundational vs. incremental. Base everything only on the metadata and summaries in my library; don't invent findings.",
    ].join("\n"),
  },
  {
    id: "compare",
    label: "Compare",
    icon: "compare",
    prompt: [
      "Compare the attached papers head to head. For each, state its core contribution in one sentence, then compare along: problem setting, method, assumptions, evaluation (data/baselines/metrics), and reported results.",
      "Make the agreements, disagreements, and complementary ideas explicit. Where they conflict, say what evidence each offers rather than declaring a winner.",
      "End with a short \"which to use when\" guide. Only use what the papers actually state; note where a fair comparison isn't possible because they measure different things.",
    ].join("\n"),
  },
  {
    id: "organize-collections",
    label: "Organize to collection",
    icon: "library",
    prompt: [
      "Help me organize papers into collections. READ my library — the papers and the existing collections — first.",
      "Propose which papers belong in which collection, reusing existing collections where they fit and suggesting a small number of new, well-named collections only where there's a clear theme. Explain each grouping in one line.",
      "Then propose the collection changes for me to approve (create collection / add papers to collection). Don't move anything without approval, and don't create near-duplicate collections.",
    ].join("\n"),
  },
  {
    id: "explain",
    label: "Explain",
    icon: "idea",
    prompt: [
      "Explain the core idea of the attached paper to me as a researcher who knows the broader field but not this specific work.",
      "Start with the one-paragraph intuition, then unpack the key method step by step. Define every new term, symbol, or acronym the paper introduces the first time you use it.",
      "Use a small worked example or analogy where it genuinely aids understanding. Ground the explanation in the paper; flag anything you're inferring rather than reading directly.",
    ].join("\n"),
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
