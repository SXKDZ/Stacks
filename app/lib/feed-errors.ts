export interface FeedErrorRecord {
  id: string;
  kind: string;
  content: string;
  createdAt: string;
}

export interface FeedErrorParts {
  summary: string;
  details: string;
}

function actionableSummary(summary: string, details: string): string {
  if (
    summary === "Agent turn failed."
    && (/"subtype"\s*:\s*"error_max_turns"/.test(details) || /Reached maximum number of turns/i.test(details))
  ) {
    return "This run reached its turn limit before finishing. Send “continue” to resume.";
  }
  // The conversation itself outgrew the model's context window: resuming sends the
  // whole session, so every further turn fails the same way in a fraction of a
  // second. Forking or rewinding starts a fresh session from a bounded slice of the
  // history, which is the only way out of it from here.
  if (summary === "Agent turn failed." && /prompt is too long/i.test(details)) {
    return "This thread's conversation no longer fits the model's context window. Fork it from an earlier turn, or rewind it, to continue with a shorter history.";
  }
  return summary;
}

export function splitFeedError(content: string): FeedErrorParts {
  const normalized = content.trim();
  if (!normalized) return { summary: "Agent turn failed.", details: "" };
  const newline = normalized.indexOf("\n");
  if (newline === -1) return { summary: normalized, details: "" };
  const summary = normalized.slice(0, newline).trim() || "Agent turn failed.";
  const details = normalized.slice(newline + 1).trim();
  return { summary: actionableSummary(summary, details), details };
}

function legacyFailurePart(content: string): { kind: "reported" | "exit"; detail: string } | null {
  if (content.trim() === "The agent reported an error.") {
    return { kind: "reported", detail: "" };
  }
  const exit = content.trim().match(/^The agent exited with code (.+)\.$/);
  return exit ? { kind: "exit", detail: `Process exit:\ncode: ${exit[1]}` } : null;
}

/** Coalesce the two rows written by older builds for one failed subprocess.
 * New builds persist one detailed row; this keeps existing feeds equally tidy
 * without mutating historical library data. */
export function coalesceLegacyAgentErrors<RecordType extends FeedErrorRecord>(messages: RecordType[]): RecordType[] {
  const output: RecordType[] = [];
  for (const message of messages) {
    const previous = output.at(-1);
    const currentPart = message.kind === "error" ? legacyFailurePart(message.content) : null;
    const previousPart = previous?.kind === "error" ? legacyFailurePart(previous.content) : null;
    const closeTogether = previous
      ? Math.abs(Date.parse(message.createdAt) - Date.parse(previous.createdAt)) <= 1_000
      : false;

    if (previous && currentPart && previousPart && currentPart.kind !== previousPart.kind && closeTogether) {
      const detail = currentPart.detail || previousPart.detail || "No diagnostic data was retained by the older app version.";
      output[output.length - 1] = {
        ...previous,
        content: `Agent turn failed.\n\n${detail}`,
      };
      continue;
    }
    output.push(message);
  }
  return output;
}
