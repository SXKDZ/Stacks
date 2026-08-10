/**
 * Interaction boundaries for feed-history selection.
 *
 * The opening instruction is not stored in feed_messages, so it is represented
 * by a stable sentinel. Every later interaction starts at a stored user message
 * and owns all following events up to (but not including) the next user message.
 * Keeping this logic shared by the UI and API lets the server validate a compact
 * list of interaction ids without accepting arbitrary client-supplied ranges.
 */

export const OPENING_INTERACTION_ID = "opening";

export interface FeedHistoryMessage {
  id: string;
  role: string;
  kind: string;
  content: string;
  toolUseId?: string | null;
  attachments?: string | null;
  createdAt: string;
}

export interface FeedInteraction<TMessage extends FeedHistoryMessage = FeedHistoryMessage> {
  id: string;
  /** The user turn that begins this interaction. */
  userText: string;
  /** Attachments on that user turn, still in their persisted JSON form. */
  userAttachments: string | null;
  /** Stored messages belonging to the interaction, including its user starter. */
  messages: TMessage[];
  opening: boolean;
}

export function groupFeedInteractions<TMessage extends FeedHistoryMessage>(
  instruction: string,
  openingAttachments: string | null | undefined,
  messages: TMessage[],
): FeedInteraction<TMessage>[] {
  const groups: FeedInteraction<TMessage>[] = [];
  let current: FeedInteraction<TMessage> = {
    id: OPENING_INTERACTION_ID,
    userText: instruction,
    userAttachments: openingAttachments ?? null,
    messages: [],
    opening: true,
  };

  const finishCurrent = () => {
    if (current.userText.trim() || current.userAttachments || current.messages.length) {
      groups.push(current);
    }
  };

  for (const message of messages) {
    if (message.role === "user") {
      finishCurrent();
      current = {
        id: message.id,
        userText: message.content,
        userAttachments: message.attachments ?? null,
        messages: [message],
        opening: false,
      };
    } else {
      current.messages.push(message);
    }
  }
  finishCurrent();
  return groups;
}

const CONVERSATION_KINDS = new Set(["text", "result"]);
const TOOL_DETAIL_KINDS = new Set(["text", "result", "tool_use", "tool_result"]);

function historyMessageAllowed(message: FeedHistoryMessage, includeToolDetails: boolean): boolean {
  // Claude persists tool observations with role="tool". Check the kind before
  // applying the conversational-role guard, otherwise selecting "tool details"
  // silently keeps every request but drops every corresponding result.
  if (message.kind === "tool_result") return includeToolDetails && message.role === "tool";
  if (message.role !== "user" && message.role !== "assistant") return false;
  return (includeToolDetails ? TOOL_DETAIL_KINDS : CONVERSATION_KINDS).has(message.kind);
}

export interface SelectedFeedHistory<TMessage extends FeedHistoryMessage = FeedHistoryMessage> {
  instruction: string;
  openingAttachments: string | null;
  messages: TMessage[];
  selectedIds: string[];
}

/**
 * Build the new feed's persisted history from server-derived interaction groups.
 * The first selected user turn becomes the new feed's opening instruction; all
 * later selected user turns remain messages. This matches how FeedDetail renders
 * a feed and avoids duplicating the first selected user turn.
 */
export function selectFeedHistory<TMessage extends FeedHistoryMessage>(input: {
  instruction: string;
  openingAttachments?: string | null;
  messages: TMessage[];
  interactionIds: string[];
  includeToolDetails: boolean;
}): SelectedFeedHistory<TMessage> {
  const groups = groupFeedInteractions(input.instruction, input.openingAttachments, input.messages);
  const requested = new Set(input.interactionIds);
  const selected = groups.filter((group) => requested.has(group.id));
  const selectedIds = selected.map((group) => group.id);

  if (selected.length !== requested.size) {
    const known = new Set(selectedIds);
    const missing = [...requested].filter((id) => !known.has(id));
    throw new Error(`Unknown interaction${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`);
  }
  if (!selected.length) {
    throw new Error("Select at least one interaction.");
  }

  const [first, ...rest] = selected;
  const firstMessages = first.messages.filter((message) => {
    // For non-opening groups the starter becomes feedSnippets.instruction.
    if (!first.opening && message.id === first.id) return false;
    return historyMessageAllowed(message, input.includeToolDetails);
  });
  const laterMessages = rest.flatMap((group) =>
    group.messages.filter((message) => historyMessageAllowed(message, input.includeToolDetails)),
  );

  return {
    instruction: first.userText,
    openingAttachments: first.userAttachments,
    messages: [...firstMessages, ...laterMessages],
    selectedIds,
  };
}

/** A fresh fork session receives this transcript as one supported user prompt. */
export function buildFeedTranscript(
  instruction: string,
  messages: FeedHistoryMessage[],
  includeToolDetails = false,
): string {
  const lines: string[] = [];
  if (instruction.trim()) lines.push(`User: ${instruction.trim()}`);
  for (const message of messages) {
    if (!historyMessageAllowed(message, includeToolDetails)) continue;
    if (message.kind === "tool_use") {
      lines.push(`Assistant tool request: ${message.content}`);
    } else if (message.kind === "tool_result") {
      lines.push(`Tool result: ${message.content}`);
    } else {
      lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${message.content}`);
    }
  }
  return lines.join("\n\n");
}
