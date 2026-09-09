/**
 * What a tool call in a feed thread actually was.
 *
 * The agent's calls are stored as one line, `"<ToolName> <input JSON>"`, which the
 * thread used to show as the bare tool name over a JSON blob. The same five things
 * the Claude Code terminal renders specially are the ones worth reading here: an edit
 * as a diff, a spawned agent as its own run, a background command as a shell with a
 * fate, a workflow as its phases, and everything else as its subject (the file, the
 * pattern, the URL) rather than as the word "tool".
 *
 * Pure functions with no React, so the parsing and the diff are tested directly.
 */

export interface FeedToolInvocation {
  name: string;
  /** The parsed input object, or null when the stored line was not JSON. */
  input: Record<string, unknown> | null;
  /** The input exactly as stored, for the raw fence. */
  raw: string;
}

/** Split a stored `tool_use` row back into the tool's name and its input. */
export function parseToolInvocation(content: string): FeedToolInvocation {
  const space = content.indexOf(" ");
  const name = space === -1 ? content : content.slice(0, space);
  const raw = space === -1 ? "" : content.slice(space + 1);
  let input: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      input = parsed as Record<string, unknown>;
    }
  } catch {
    input = null;
  }
  return { name: name || "tool", input, raw };
}

export type DiffLineType = "add" | "remove" | "context";
export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface FeedDiff {
  /** Path as the agent gave it. */
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  /** True when the whole file is being written, so there is no "before" side. */
  whole: boolean;
}

/**
 * A tool call's one-line heading, in three parts.
 *
 * They are separate because they behave differently in a row that runs out of width:
 * the verb must stay whole (a card reading "Sh…" says nothing), the subject is code and
 * may be cut, and the stat is short enough to always keep.
 */
export interface FeedToolHeading {
  /** What the call is, in words: "Edit", "Background shell", "Explore subagent". */
  name: string;
  /** What it acted on, set in code: a path, a command, an id. */
  subject?: string;
  /** A short measure of it: "+9 −1". */
  stat?: string;
}

export type FeedToolView =
  | { kind: "diff"; heading: FeedToolHeading; diff: FeedDiff }
  | { kind: "subagent"; heading: FeedToolHeading; agent: string; description: string; prompt: string; background: boolean }
  | { kind: "shell"; heading: FeedToolHeading; command: string; description?: string; background: boolean }
  | { kind: "workflow"; heading: FeedToolHeading; name: string; description: string; phases: string[]; script: string }
  | { kind: "generic"; heading: FeedToolHeading };

const DIFF_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/** A line diff of two blocks, longest-common-subsequence aligned. */
export function diffLines(before: string, after: string): DiffLine[] {
  const left = before === "" ? [] : before.split("\n");
  const right = after === "" ? [] : after.split("\n");
  // An alignment is quadratic, and an edit big enough to matter reads no better for
  // it: past this size the two sides are shown whole, removed then added.
  if (left.length * right.length > 250_000) {
    return [
      ...left.map((text): DiffLine => ({ type: "remove", text })),
      ...right.map((text): DiffLine => ({ type: "add", text })),
    ];
  }
  // lcs[i][j] = length of the longest common subsequence of left[i…] and right[j…].
  const lcs: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = left[i] === right[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      lines.push({ type: "context", text: left[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ type: "remove", text: left[i] });
      i += 1;
    } else {
      lines.push({ type: "add", text: right[j] });
      j += 1;
    }
  }
  while (i < left.length) lines.push({ type: "remove", text: left[i++] });
  while (j < right.length) lines.push({ type: "add", text: right[j++] });
  return lines;
}

function text(input: Record<string, unknown> | null, key: string): string {
  const value = input?.[key];
  return typeof value === "string" ? value : "";
}

/** The last two path segments: enough to tell two `route.ts` apart, short enough
 *  for a summary line. */
export function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : parts.slice(-2).join("/");
}

/** One line of a longer value, for a summary that must not wrap. */
function oneLine(value: string, limit = 160): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function editDiff(name: string, input: Record<string, unknown> | null): FeedDiff {
  const path = text(input, "file_path") || text(input, "notebook_path") || text(input, "path");
  if (name === "Write") {
    const content = text(input, "content");
    const lines = (content === "" ? [] : content.split("\n")).map((line): DiffLine => ({ type: "add", text: line }));
    return { path, lines, added: lines.length, removed: 0, whole: true };
  }
  if (name === "MultiEdit") {
    const edits = Array.isArray(input?.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
    const lines = edits.flatMap((edit, index) => [
      ...(index ? [{ type: "context" as const, text: "" }] : []),
      ...diffLines(text(edit, "old_string"), text(edit, "new_string")),
    ]);
    return { path, lines, ...counts(lines), whole: false };
  }
  if (name === "NotebookEdit") {
    const source = text(input, "new_source");
    const lines = diffLines(text(input, "old_source"), source);
    return { path, lines, ...counts(lines), whole: !text(input, "old_source") };
  }
  const lines = diffLines(text(input, "old_string"), text(input, "new_string"));
  return { path, lines, ...counts(lines), whole: false };
}

function counts(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.type === "add").length,
    removed: lines.filter((line) => line.type === "remove").length,
  };
}

/**
 * A workflow's own description of itself. The script must open with a literal
 * `export const meta = {…}`, so the name and description are readable without
 * running anything; phases are the titles it lists.
 */
export function workflowMeta(script: string, fallbackName: string): { name: string; description: string; phases: string[] } {
  const meta = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/.exec(script)?.[1] ?? "";
  const field = (key: string) => new RegExp(`${key}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`).exec(meta)?.[2] ?? "";
  const phases = [...meta.matchAll(/title\s*:\s*(['"`])([\s\S]*?)\1/g)].map((match) => match[2]);
  return { name: field("name") || fallbackName, description: field("description"), phases };
}

/**
 * How a stored tool call should read in the thread.
 *
 * The heading names the operation and what it acted on; the kind selects the body: a
 * diff, a subagent's run, a shell, a workflow, or the raw request/result pair
 * everything else keeps.
 */
export function describeToolCall(invocation: FeedToolInvocation): FeedToolView {
  const { name, input } = invocation;

  if (DIFF_TOOLS.has(name)) {
    const diff = editDiff(name, input);
    return {
      kind: "diff",
      heading: {
        name: name === "Write" ? "Write" : "Edit",
        subject: diff.path ? shortPath(diff.path) : undefined,
        stat: `+${diff.added} −${diff.removed}`,
      },
      diff,
    };
  }

  if (SUBAGENT_TOOLS.has(name)) {
    const agent = text(input, "subagent_type") || "agent";
    const description = text(input, "description");
    return {
      kind: "subagent",
      heading: { name: `${agent} subagent`, subject: description ? oneLine(description) : undefined },
      agent,
      description,
      prompt: text(input, "prompt"),
      background: input?.run_in_background === true,
    };
  }

  if (name === "Bash") {
    const command = text(input, "command");
    const background = input?.run_in_background === true;
    return {
      kind: "shell",
      heading: { name: background ? "Background shell" : "Shell", subject: oneLine(command) },
      command,
      description: text(input, "description") || undefined,
      background,
    };
  }

  if (name === "Workflow") {
    const script = text(input, "script");
    const meta = workflowMeta(script, text(input, "name") || "workflow");
    return {
      kind: "workflow",
      heading: {
        name: "Workflow",
        subject: meta.name,
        stat: meta.phases.length ? `${meta.phases.length} phases` : undefined,
      },
      name: meta.name,
      description: meta.description,
      phases: meta.phases,
      script,
    };
  }

  // Watching or ending something already running: the id is the whole subject.
  if (name === "BashOutput" || name === "TaskOutput" || name === "KillShell" || name === "TaskStop") {
    const id = text(input, "bash_id") || text(input, "task_id") || text(input, "shell_id") || text(input, "id");
    return {
      kind: "generic",
      heading: {
        name: name === "KillShell" || name === "TaskStop" ? "Stop background task" : "Background output",
        subject: id || undefined,
      },
    };
  }

  // Everything else: name the subject, so a row of tool calls can be read without
  // opening any of them.
  const subject = text(input, "file_path")
    || text(input, "path")
    || text(input, "pattern")
    || text(input, "url")
    || text(input, "query")
    || text(input, "prompt")
    || text(input, "skill")
    || text(input, "description");
  return {
    kind: "generic",
    heading: {
      name,
      subject: subject ? oneLine(name === "Read" || name === "Glob" ? shortPath(subject) : subject) : undefined,
    },
  };
}

/** What a background command or a subagent reported when it finished. Stored as a
 *  `task` message against the tool call it belongs to. */
export interface FeedTaskReport {
  status: string;
  summary: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export function parseTaskReport(content: string): FeedTaskReport | null {
  try {
    const parsed = JSON.parse(content) as {
      status?: unknown;
      summary?: unknown;
      usage?: { total_tokens?: unknown; tool_uses?: unknown; duration_ms?: unknown } | null;
    };
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
    return {
      status: typeof parsed.status === "string" ? parsed.status : "",
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      totalTokens: number(parsed.usage?.total_tokens),
      toolUses: number(parsed.usage?.tool_uses),
      durationMs: number(parsed.usage?.duration_ms),
    };
  } catch {
    return null;
  }
}

/** The shell id in a backgrounded Bash result, so the card can name what to watch. */
export function backgroundShellId(result: string | undefined): string | null {
  return result ? /running in background with ID:\s*(\S+?)[.\s]/.exec(result)?.[1] ?? null : null;
}

/** One notable thing an interaction did, as the thread's outline lists it. */
export interface FeedOutlineOperation {
  /** The tool_use message's id, which the card carries as its anchor. */
  id: string;
  kind: "diff" | "subagent" | "shell" | "workflow";
  heading: FeedToolHeading;
}

/** One turn of the thread, with whatever is worth jumping to inside it. */
export interface FeedOutlineEntry {
  id: string;
  label: string;
  opening: boolean;
  operations: FeedOutlineOperation[];
}

/** A turn's request on one line, for a rail 240px wide. */
function outlineLabel(userText: string, opening: boolean): string {
  const first = userText.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const trimmed = first.length > 90 ? `${first.slice(0, 89)}…` : first;
  return trimmed || (opening ? "Opening request" : "Attachments");
}

/**
 * The thread's outline: every turn, and the operations inside it worth finding again.
 *
 * A long thread is mostly prose and file reads, and what a reader comes back for is
 * the handful of consequential steps: what was edited, which agents ran, what was left
 * running in a shell, which workflow was started. Foreground commands and file reads
 * are deliberately not listed — one turn can hold ninety of them, which would bury the
 * four that matter.
 */
export function buildFeedOutline(
  interactions: Array<{
    id: string;
    userText: string;
    opening: boolean;
    messages: Array<{ id: string; kind: string; content: string; parentToolUseId?: string | null }>;
  }>,
): FeedOutlineEntry[] {
  return interactions.map((interaction) => ({
    id: interaction.id,
    label: outlineLabel(interaction.userText, interaction.opening),
    opening: interaction.opening,
    operations: interaction.messages.flatMap((message): FeedOutlineOperation[] => {
      // A subagent's own edits and shells belong to its card, not to the outline of
      // the thread: the agent that ran them is the entry worth listing.
      if (message.kind !== "tool_use" || message.parentToolUseId) return [];
      const view = describeToolCall(parseToolInvocation(message.content));
      if (view.kind === "diff" || view.kind === "subagent" || view.kind === "workflow") {
        return [{ id: message.id, kind: view.kind, heading: view.heading }];
      }
      if (view.kind === "shell" && view.background) {
        return [{ id: message.id, kind: "shell", heading: view.heading }];
      }
      return [];
    }),
  }));
}

/**
 * Whether a tool result is the CLI's async-agent launch metadata rather than an answer.
 *
 * It carries an internal agent id and says in as many words not to repeat any of it, so
 * a card showing it verbatim shows the reader a wall of text addressed to the model.
 * What the agent found arrives separately, as its report.
 */
export function isAsyncAgentMetadata(result: string | undefined): boolean {
  return typeof result === "string" && /^Async agent launched successfully/.test(result.trim());
}
