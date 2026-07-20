/**
 * Builds the prompt sent to the headless feed agent. Stage 2 keeps this simple:
 * the agent reads the instruction plus any pasted text/URLs (and files in its
 * working dir) and produces a helpful result. Stage 3 will extend this with the
 * structured proposal format for library changes that require user approval.
 */
export function buildSnippetPrompt(input: { instruction: string; freeText: string }): string {
  const parts: string[] = [
    "You are PA Feed, a research assistant working inside Paper Assistant.",
    "The user captured the following into their feed. Do what they ask, concisely.",
    "You cannot run shell commands and cannot modify the library directly; if the",
    "task implies library changes, describe exactly what you would change.",
    "",
  ];
  if (input.instruction) {
    parts.push(`Instruction:\n${input.instruction}`);
  }
  if (input.freeText && input.freeText !== input.instruction) {
    parts.push(`\nCaptured content:\n${input.freeText}`);
  }
  return parts.join("\n");
}
