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

/**
 * The stored messages an interaction and every later one own.
 *
 * This is what a rewind to that point removes, and the complement of the history a
 * fork from that point keeps, so both are expressed against the same interaction
 * boundaries the selection UI shows. Empty for an id that is not a boundary, which
 * the route turns into a 404.
 */
export function messagesFromInteraction<TMessage extends FeedHistoryMessage>(
  groups: FeedInteraction<TMessage>[],
  interactionId: string,
): TMessage[] {
  const index = groups.findIndex((group) => group.id === interactionId);
  return index < 0 ? [] : groups.slice(index).flatMap((group) => group.messages);
}

/** The interactions before `interactionId`: the history that survives a rewind to
 *  that point, and the selection a fork from that point copies. */
export function interactionsBefore<TMessage extends FeedHistoryMessage>(
  groups: FeedInteraction<TMessage>[],
  interactionId: string,
): string[] {
  const index = groups.findIndex((group) => group.id === interactionId);
  return index <= 0 ? [] : groups.slice(0, index).map((group) => group.id);
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

/**
 * Roughly 32k tokens of history: enough to carry dozens of turns, and small enough
 * that the seeded prompt plus the turn's own work still fits the model's window.
 * The cap is the point of this budget: a long thread is megabytes of transcript
 * (one 405-turn feed here is 1.2 MB), and a prompt that large is refused outright
 * with "Prompt is too long" before the agent does anything.
 */
const TRANSCRIPT_BUDGET_CHARS = 120_000;
/**
 * No single message may spend the whole budget. A 100 kB tool result would
 * otherwise crowd out every turn around it, and its opening lines are the part
 * worth carrying.
 */
const TRANSCRIPT_MESSAGE_CHARS = 4_000;

function clipForTranscript(text: string): string {
  return text.length <= TRANSCRIPT_MESSAGE_CHARS
    ? text
    : `${text.slice(0, TRANSCRIPT_MESSAGE_CHARS)}\n[${text.length - TRANSCRIPT_MESSAGE_CHARS} more characters omitted]`;
}

function transcriptLine(message: FeedHistoryMessage): string {
  const content = clipForTranscript(message.content);
  if (message.kind === "tool_use") return `Assistant tool request: ${content}`;
  if (message.kind === "tool_result") return `Tool result: ${content}`;
  return `${message.role === "user" ? "User" : "Assistant"}: ${content}`;
}

/**
 * A fresh fork session receives this transcript as one supported user prompt.
 *
 * The opening instruction always survives, since it is what the thread was for.
 * The rest is taken newest first and stops at the budget: a continuation needs the
 * end of the conversation, and dropping the oldest turns keeps what remains
 * contiguous. What was dropped is stated rather than left to look like the thread
 * simply began there.
 */
export function buildFeedTranscript(
  instruction: string,
  messages: FeedHistoryMessage[],
  includeToolDetails = false,
): string {
  const opening = instruction.trim() ? `User: ${clipForTranscript(instruction.trim())}` : "";
  const carried = messages.filter((message) => historyMessageAllowed(message, includeToolDetails));
  const recent: string[] = [];
  let remaining = TRANSCRIPT_BUDGET_CHARS - opening.length;
  let omitted = 0;
  for (let index = carried.length - 1; index >= 0; index -= 1) {
    const line = transcriptLine(carried[index]);
    if (line.length + 2 > remaining) {
      omitted = index + 1;
      break;
    }
    remaining -= line.length + 2;
    recent.push(line);
  }
  recent.reverse();
  const note = omitted
    ? `[${omitted} earlier message${omitted === 1 ? "" : "s"} omitted: this thread is longer than one prompt can carry]`
    : "";
  return [opening, note, ...recent].filter(Boolean).join("\n\n");
}
