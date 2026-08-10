import type { FeedHistoryMessage } from "@/app/lib/feed-history";

function codeFence(content: string): string {
  const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${content}\n${fence}`;
}

function messageLabel(message: FeedHistoryMessage): string {
  if (message.kind === "tool_use") return "Agent tool request";
  if (message.kind === "tool_result") return "Tool result";
  if (message.kind === "error") return "Error";
  if (message.role === "user") return "You";
  if (message.role === "assistant") return "Agent";
  if (message.role === "system") return "System";
  return message.role || "Event";
}

/** Serialize a feed exactly in reading order, including its separately stored opening turn. */
export function feedMarkdown(input: {
  title: string;
  instruction: string;
  messages: FeedHistoryMessage[];
}): string {
  const lines = [`# ${input.title}`, ""];
  if (input.instruction.trim()) {
    lines.push(`**You:** ${input.instruction}`, "");
  }

  for (const message of input.messages) {
    const label = messageLabel(message);
    if (message.kind === "tool_use" || message.kind === "tool_result") {
      lines.push(`**${label}:**`, "", codeFence(message.content), "");
    } else {
      lines.push(`**${label}:** ${message.content}`, "");
    }
  }

  return lines.join("\n");
}
