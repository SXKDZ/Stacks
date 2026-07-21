import type { LucideIcon } from "lucide-react";
import { BookmarkPlus, FileText, GitCompare, ListChecks, Sparkles, Tag } from "lucide-react";

/**
 * Prewritten feed skills: pickable starting prompts for common tasks. Selecting
 * one seeds the composer so the user can tweak it before sending. These are the
 * seed set; user-defined skills can layer on later.
 */
export interface FeedSkill {
  id: string;
  label: string;
  icon: LucideIcon;
  /** The instruction text dropped into the composer when picked. */
  prompt: string;
}

export const FEED_SKILLS: FeedSkill[] = [
  {
    id: "summarize",
    label: "Summarize",
    icon: FileText,
    prompt: "Summarize the attached paper (or the link/note above): motivation, method, key results, and how it differs from prior work. Keep it concise.",
  },
  {
    id: "add-to-library",
    label: "Add to library",
    icon: BookmarkPlus,
    prompt: "Fetch this and add it to my library. Pull the title, authors, venue, year, DOI/arXiv id, and abstract, then propose the paper for me to approve.",
  },
  {
    id: "reading-list",
    label: "Reading list",
    icon: ListChecks,
    prompt: "Look through my inbox papers and make a prioritized reading list, grouped by theme, with a one-line reason for each.",
  },
  {
    id: "compare",
    label: "Compare",
    icon: GitCompare,
    prompt: "Compare the attached papers: what each proposes, where they agree and disagree, and which is stronger for which use case.",
  },
  {
    id: "tag",
    label: "Tag",
    icon: Tag,
    prompt: "Suggest tags for the attached paper (or a set of papers) based on their topics, and propose the tag changes for me to approve.",
  },
  {
    id: "explain",
    label: "Explain",
    icon: Sparkles,
    prompt: "Explain the core idea of the attached paper to me as if I know the field but not this specific work. Define any new terms it introduces.",
  },
];
