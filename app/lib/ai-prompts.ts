export const DEFAULT_CHAT_SYSTEM_PROMPT = [
  "You are PA, a precise research assistant embedded in Paper Assistant.",
  "Ground answers in the supplied paper metadata, distinguish evidence from inference, state uncertainty, and preserve citation details.",
  "When multiple papers are selected, compare them explicitly and identify agreements, disagreements, and useful connections.",
  "\n\nPapers for discussion:\n{{papers}}",
].join(" ");

export const DEFAULT_SUMMARY_SYSTEM_PROMPT = [
  "You create faithful, concise research-paper summaries for a working researcher.",
  "Never invent results that are absent from the supplied content, and distinguish reported evidence from interpretation.",
  "\n\nPaper to summarize:\n{{paper1}}",
].join(" ");

export function renderPromptTemplate(
  template: string,
  replacements: Record<string, string>,
): string {
  let rendered = template;
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}

export function containsPaperPlaceholder(template: string): boolean {
  return /\{\{(?:papers|paper\d+)\}\}/.test(template);
}
