/** Claude Code can run Anthropic Bedrock models, not direct OpenAI models. */
export function isClaudeAgentModel(modelId: string): boolean {
  return modelId.startsWith("anthropic.") || modelId.includes(".anthropic.");
}

/** A feed-specific choice wins; otherwise use the Claude model saved in Settings. */
export function feedAgentModel(snippetModel: string | null | undefined, configuredModel: string): string {
  return snippetModel?.trim() || (isClaudeAgentModel(configuredModel.trim()) ? configuredModel.trim() : "");
}
