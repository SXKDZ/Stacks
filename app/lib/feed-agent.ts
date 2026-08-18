import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { libraryRoot } from "@/db/library-paths";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import { claudeEffortArgs, effortSetting } from "@/app/lib/effort";
import { isStoppedExit } from "@/app/lib/agent-exit";
import { formatAgentFailure } from "@/app/lib/agent-error";
import { buildForkPrompt, parseProposalsResult, type ProposalOperation } from "@/app/lib/feed-prompt";
import { issueFeedToken, revokeFeedToken } from "@/app/lib/feed-token";
import { feedAgentModel } from "@/app/lib/feed-model";
import { proposalSummary } from "@/app/lib/schemas/proposals";

/**
 * Drives a headless `claude -p` agent for one feed snippet. The agent runs with
 * Stacks's Bedrock credentials, no Bash (so it cannot touch the machine or call Stacks's
 * API — it only proposes changes as structured output), and its own working
 * directory. Follow-up turns resume the same session so history carries forward.
 *
 * stream-json events are parsed and persisted to feed_messages, and pushed to
 * any live SSE subscribers. The subprocess is tracked so it can be stopped.
 */

type FeedEvent =
  | { type: "status"; status: string }
  | { type: "message"; id: string; role: string; kind: string; content: string; toolUseId?: string | null; createdAt: string }
  | { type: "proposal"; id: string; messageId: string | null; operation: string; status: string; summary: string; createdAt: string }
  | { type: "done"; status: string };

const CLAUDE_BIN = process.env.STACKS_CLAUDE_BIN?.trim() || "claude";

interface RunHandle {
  child: ChildProcess;
  /**
   * Set when Stacks asked this run to stop (a Stop press or interrupt-then-send).
   *
   * The exit code alone can't tell us: the CLI traps SIGTERM and exits 143 on its
   * own, so Node reports `code: 143, signal: null` rather than the signal. Without
   * this flag a user-initiated stop fell into the error branch and the thread showed
   * "The agent reported an error" / "exited with code 143" for something the user
   * did deliberately.
   */
  stopRequested?: boolean;
}

/** The outcome of a single agent turn, resolved when its process exits. */
export interface AgentTurnResult {
  status: "done" | "error" | "stopped";
  /** The agent's final assistant/result text (empty on error/stop). */
  text: string;
  error?: string;
}

interface FeedRuntimeState {
  runs: Map<string, RunHandle>;
  launching: Set<string>;
  subscribers: Map<string, Set<(event: FeedEvent) => void>>;
}

// Route modules can be re-evaluated independently in Next.js (especially during
// development). A module-local Map then forgets a still-running child: the SSE
// route reports Done, while the orphaned handler keeps saving messages that only
// appear after refresh. Keep one process-wide registry so every route bundle and
// hot reload sees the same run and subscribers.
const feedRuntimeGlobal = globalThis as typeof globalThis & {
  __stacksFeedRuntimeV1?: FeedRuntimeState;
};
const feedRuntime = feedRuntimeGlobal.__stacksFeedRuntimeV1 ??= {
  runs: new Map<string, RunHandle>(),
  launching: new Set<string>(),
  subscribers: new Map<string, Set<(event: FeedEvent) => void>>(),
};
const { runs, launching, subscribers } = feedRuntime;

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * The sandboxed working directory for one feed.
 *
 * The id is validated here rather than at each call site: it arrives from a URL
 * segment, and a value like `../../x` would otherwise resolve OUTSIDE the library
 * root. That mattered in two directions: the attachment route would serve any
 * file on the machine, and the DELETE handler would `rmSync(..., recursive)` an
 * arbitrary directory. Feed ids are generated as `feed-<uuid>`, so a plain
 * segment of id characters is the whole legitimate alphabet.
 */
export function feedWorkingDir(snippetId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(snippetId) || snippetId === "." || snippetId === "..") {
    throw new Error("Invalid feed id.");
  }
  return join(libraryRoot(), "feed", snippetId);
}

/** Flatten a tool_result content field (string, or array of text blocks) without
 * truncating it: the expanded tool card is the audit trail for agent actions. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Build Claude Code's per-run turn cap. Zero means the user chose unlimited. */
export function feedMaxTurnsArgs(value: string | undefined): string[] {
  const maxTurns = Number(value);
  return Number.isSafeInteger(maxTurns) && maxTurns > 0
    ? ["--max-turns", String(maxTurns)]
    : [];
}

export function isFeedRunning(snippetId: string): boolean {
  return runs.has(snippetId) || launching.has(snippetId);
}

/** Subscribe to live events for a running snippet; returns an unsubscribe fn. */
export function subscribeFeed(snippetId: string, listener: (event: FeedEvent) => void): () => void {
  if (!isFeedRunning(snippetId)) {
    return () => {};
  }
  const listeners = subscribers.get(snippetId) ?? new Set();
  listeners.add(listener);
  subscribers.set(snippetId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && subscribers.get(snippetId) === listeners) {
      subscribers.delete(snippetId);
    }
  };
}

function signalRun(snippetId: string, signal: NodeJS.Signals): void {
  const handle = runs.get(snippetId);
  if (handle?.child.pid) {
    try {
      // Signal the whole process group (detached spawn), so child tools die too.
      process.kill(-handle.child.pid, signal);
    } catch {
      handle.child.kill(signal);
    }
  }
}

/**
 * Ask a running agent to stop.
 *
 * A control request first, which is a graceful interrupt: the agent abandons the
 * current turn but writes its partial output and shuts the session down cleanly,
 * so the transcript stays resumable and the next turn keeps full context. Only
 * honoured with stream-json input, hence the prompt going in over stdin.
 *
 * stdin is closed just after, because the process otherwise waits for more input
 * instead of exiting. SIGTERM stays as the fallback for a process that ignores the
 * request (or was started before this path existed).
 */
export async function stopFeed(snippetId: string): Promise<void> {
  const handle = runs.get(snippetId);
  if (!handle) {
    return;
  }
  handle.stopRequested = true;
  const stdin = handle.child.stdin;
  if (stdin && stdin.writable) {
    try {
      stdin.write(`${JSON.stringify({ type: "control_request", request_id: `stop-${snippetId}`, request: { subtype: "interrupt" } })}\n`);
      stdin.end();
      return;
    } catch {
      // Fall through to the signal: a broken pipe means it can't hear us.
    }
  }
  signalRun(snippetId, "SIGTERM");
}

/**
 * Stop a running agent and wait until its process has fully exited (the close
 * handler removes it from `runs`). Callers that immediately start a new turn on
 * the same session must await this, so two `claude -p --resume` processes never
 * write the same transcript at once. Resolves immediately if not running.
 *
 * Escalates to SIGKILL near the deadline rather than returning while the process
 * is still alive: a caller that starts a new --resume turn against a
 * still-running process would corrupt the shared session transcript.
 */
export async function stopFeedAndWait(snippetId: string, timeoutMs = 8000): Promise<void> {
  if (!runs.has(snippetId)) {
    return;
  }
  await stopFeed(snippetId);
  const start = Date.now();
  let escalated = false;
  while (runs.has(snippetId) && Date.now() - start < timeoutMs) {
    // If SIGTERM hasn't landed by 75% of the budget, force-kill so we never
    // leave a live process behind when we return.
    if (!escalated && Date.now() - start > timeoutMs * 0.75) {
      signalRun(snippetId, "SIGKILL");
      escalated = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  // Final backstop: if it still hasn't exited, SIGKILL and wait a short grace so
  // the caller doesn't proceed to a second --resume on the same session.
  if (runs.has(snippetId)) {
    signalRun(snippetId, "SIGKILL");
    const graceEnd = Date.now() + 2000;
    while (runs.has(snippetId) && Date.now() < graceEnd) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
}

async function persistMessage(
  snippetId: string,
  role: string,
  kind: string,
  content: string,
  toolUseId: string | null = null,
): Promise<FeedEvent> {
  const database = await ensureDatabase();
  const id = createId("msg");
  const createdAt = new Date().toISOString();
  database.insert(feedMessages).values({ id, snippetId, role, kind, content, toolUseId, createdAt }).run();
  return { type: "message", id, role, kind, content, toolUseId, createdAt };
}

async function persistProposal(
  snippetId: string,
  messageId: string | null,
  operation: ProposalOperation,
): Promise<FeedEvent> {
  const database = await ensureDatabase();
  const id = createId("prop");
  const createdAt = new Date().toISOString();
  const serialized = JSON.stringify(operation);
  database
    .insert(feedProposals)
    .values({ id, snippetId, messageId, operation: serialized, status: "pending", createdAt })
    .run();
  return { type: "proposal", id, messageId, operation: serialized, status: "pending", summary: proposalSummary(operation), createdAt };
}

async function setStatus(snippetId: string, status: string, error?: string): Promise<void> {
  const database = await ensureDatabase();
  database
    .update(feedSnippets)
    .set({ status, error: error ?? null, updatedAt: new Date().toISOString() })
    .where(eq(feedSnippets.id, snippetId))
    .run();
}

async function setSessionId(snippetId: string, sessionId: string): Promise<void> {
  const database = await ensureDatabase();
  database
    .update(feedSnippets)
    .set({ sessionId })
    .where(and(eq(feedSnippets.id, snippetId), eq(feedSnippets.sessionId, "")))
    .run();
}

/** Clear the session id so the fresh-session retry can claim a new one. */
async function clearSessionId(snippetId: string): Promise<void> {
  const database = await ensureDatabase();
  database.update(feedSnippets).set({ sessionId: "" }).where(eq(feedSnippets.id, snippetId)).run();
}

/** A plain-text transcript of the thread so far (user + agent turns), used to
 *  seed a fresh session when a resume can't find its original conversation. */
async function threadTranscript(snippetId: string): Promise<string> {
  const database = await ensureDatabase();
  return database
    .select()
    .from(feedMessages)
    .where(eq(feedMessages.snippetId, snippetId))
    .orderBy(asc(feedMessages.createdAt))
    .all()
    .filter((message) => message.kind === "text" || message.kind === "result")
    .map((message) => `${message.role === "user" ? "User" : "Agent"}: ${message.content}`)
    .join("\n\n");
}

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  turns: number;
}

/** A turn's usage as reported by the stream-json `result` event. Tokens sum
 *  across cache + input/output. Null when the event carried no usage at all. */
function turnUsage(event: Record<string, unknown>): TurnUsage | null {
  const usage = (event.usage ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const inputTokens = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
  const outputTokens = num(usage.output_tokens);
  const durationMs = num(event.duration_ms);
  if (!inputTokens && !outputTokens && !durationMs) return null;
  return { inputTokens, outputTokens, durationMs, turns: num(event.num_turns) || 1 };
}

/** Accumulate a turn's usage onto the feed: duration and turn count add up over
 *  follow-ups, so the header keeps showing the whole thread's cost. */
async function recordUsage(snippetId: string, usage: TurnUsage): Promise<void> {
  const database = await ensureDatabase();
  database
    .update(feedSnippets)
    .set({
      inputTokens: sql`${feedSnippets.inputTokens} + ${usage.inputTokens}`,
      outputTokens: sql`${feedSnippets.outputTokens} + ${usage.outputTokens}`,
      durationMs: sql`${feedSnippets.durationMs} + ${usage.durationMs}`,
      turns: sql`${feedSnippets.turns} + ${usage.turns}`,
    })
    .where(eq(feedSnippets.id, snippetId))
    .run();
}

/** Stamp the same usage on the message the turn ends with, so the thread can show
 *  that reply's own tokens and speed instead of only the feed-wide totals. */
async function recordMessageUsage(messageId: string, usage: TurnUsage): Promise<void> {
  const database = await ensureDatabase();
  database
    .update(feedMessages)
    .set({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, durationMs: usage.durationMs })
    .where(eq(feedMessages.id, messageId))
    .run();
}

function emit(snippetId: string, event: FeedEvent): void {
  subscribers.get(snippetId)?.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // A failing subscriber must not break the run.
    }
  });
}

function feedBaseUrl(): string {
  return process.env.STACKS_FEED_BASE_URL?.trim() || `http://127.0.0.1:${process.env.PORT?.trim() || "3000"}`;
}

/** Claude Code's config/transcript dir, kept inside the library so the raw
 *  session JSONL is captured in the synced folder (not scattered in ~/.claude). */
function claudeConfigDir(): string {
  return join(libraryRoot(), "feed", ".claude");
}

async function agentEnv(feedToken: string): Promise<NodeJS.ProcessEnv> {
  const runtime = await resolveRuntimeValues();
  const token = runtimeValue(runtime, "AWS_BEARER_TOKEN_BEDROCK");
  const region = runtimeValue(runtime, "AWS_REGION", "us-east-1");
  return {
    ...process.env,
    ...(token ? { CLAUDE_CODE_USE_BEDROCK: "1", AWS_BEARER_TOKEN_BEDROCK: token, AWS_REGION: region } : {}),
    // Keep the agent's session transcripts inside the (synced) library.
    CLAUDE_CONFIG_DIR: claudeConfigDir(),
    // The agent uses these (via Bash + curl) to query and edit the library.
    STACKS_FEED_BASE_URL: feedBaseUrl(),
    STACKS_FEED_TOKEN: feedToken,
  };
}

/**
 * Spawn (or resume) the agent for a snippet with the given prompt. `sessionId`
 * is the explicit UUID for the conversation: on the first turn we set it; on
 * follow-ups we resume it. Returns once the process is launched; events stream
 * asynchronously to subscribers and are persisted.
 */
export async function runFeedAgent(options: {
  snippetId: string;
  sessionId: string;
  prompt: string;
  resume: boolean;
  /** Internal: true on the fresh-session retry after a failed resume. */
  resumeRetried?: boolean;
}): Promise<AgentTurnResult> {
  const { snippetId, sessionId, prompt, resume, resumeRetried = false } = options;
  // Claim synchronously, before the first await. Concurrent route requests can
  // otherwise both pass their preflight check and launch two resumptions of the
  // same session, allowing one process to mark Done while the other still emits.
  if (isFeedRunning(snippetId)) {
    return {
      status: "error",
      text: "",
      error: "Another agent turn is already running. Wait for it to finish or stop it before sending another reply.",
    };
  }
  launching.add(snippetId);
  // Resolved when the process exits (or the resume-fallback turn it spawns does),
  // so a caller can await the turn's outcome — the workflow runtime relies on this.
  let settle: (result: AgentTurnResult) => void;
  const completion = new Promise<AgentTurnResult>((resolve) => { settle = resolve; });
  const workingDir = feedWorkingDir(snippetId);

  // Everything up to the spawn can throw (disk full, DB locked, bad env). Do it
  // all here so a failure is turned into a visible "error" status rather than a
  // rejected promise the callers swallow with .catch(() => {}), which would
  // strand the snippet in "queued"/"running" and poll forever.
  let child: ReturnType<typeof spawn>;
  try {
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(claudeConfigDir(), { recursive: true });

    // The per-feed model choice lives on the snippet row, so every turn (create,
    // reply, fork retry, GitHub sync) runs with the same model automatically.
    const database = await ensureDatabase();
    const row = database
      .select({ model: feedSnippets.model, effort: feedSnippets.effort })
      .from(feedSnippets)
      .where(eq(feedSnippets.id, snippetId))
      .get();
    // Per-feed effort wins; otherwise the global Settings value. Either can be
    // unset, in which case no --effort is passed and the CLI picks its own.
    const runtime = await resolveRuntimeValues();
    const model = feedAgentModel(row?.model, runtimeValue(runtime, "BEDROCK_MODEL_ID"));
    const effort = effortSetting(row?.effort) || effortSetting(runtimeValue(runtime, "STACKS_EFFORT"));

    // Resolve the environment (secrets, config dir) before spawn so no await
    // sits between spawn() and the listener attachment below.
    const env = await agentEnv(issueFeedToken(snippetId));

    const args = [
      "-p",
      // The prompt goes in over stdin rather than argv. That is what buys graceful
      // interruption: a control request is only honoured with stream-json input, and
      // with a text prompt the CLI ignores it and runs the turn to completion
      // (verified). One process per turn is unchanged.
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--add-dir",
      workingDir,
      // Scratch space: the agent fetches an attached paper's PDF (via the
      // token-gated file API) into a temp file and reads it, rather than us
      // copying every attached paper into the feed dir. /tmp is outside the
      // library, so nothing it writes there can touch stored files.
      "--add-dir",
      "/tmp",
      ...(model ? ["--model", model] : []),
      ...claudeEffortArgs(effort),
      ...feedMaxTurnsArgs(runtimeValue(runtime, "STACKS_FEED_MAX_TURNS", "40")),
      // Headless: with no user to answer prompts, the default mode auto-denies
      // every Bash/network/temp-file call, so the agent can't even read the
      // library. "auto" keeps the background safety classifier as a guardrail
      // while letting normal operations run. Library WRITES stay safe regardless:
      // the feed API only queues proposals for the user to approve.
      "--permission-mode",
      "auto",
      ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ];

    await setStatus(snippetId, "running");
    emit(snippetId, { type: "status", status: "running" });

    child = spawn(CLAUDE_BIN, args, {
      cwd: workingDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    // Deliver the prompt, then leave stdin OPEN: closing it here would end the
    // session before an interrupt could be sent. stopFeed() closes it after the
    // control request, which is what lets the process exit.
    child.stdin?.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The agent could not be started.";
    launching.delete(snippetId);
    revokeFeedToken(snippetId);
    await persistMessage(snippetId, "system", "error", message);
    await setStatus(snippetId, "error", message);
    emit(snippetId, { type: "done", status: "error" });
    return { status: "error", text: "", error: message };
  }

  const handle: RunHandle = { child };
  runs.set(snippetId, handle);
  launching.delete(snippetId);

  let buffer = "";
  let stderr = "";
  let sessionCaptured = resume;
  let lastAssistantText = "";
  let lastAssistantId: string | null = null;
  // The final result text of this turn, surfaced to awaiting callers.
  let finalText = "";
  // A failed result is finalized only when the process closes, when its
  // structured event, stderr, exit code, and signal are all available. Older
  // code persisted here and again in `close`, producing two error cards.
  let failedResultEvent: Record<string, unknown> | null = null;
  let terminalSettled = false;
  // Set when a --resume run fails because its session transcript is missing; the
  // close handler then restarts the turn as a fresh session with the transcript.
  let resumeFallback = false;

  const handleLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (event.type === "system" && event.subtype === "init" && !sessionCaptured) {
      sessionCaptured = true;
      const id = typeof event.session_id === "string" ? event.session_id : sessionId;
      await setSessionId(snippetId, id);
      return;
    }
    if (event.type === "assistant") {
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          const persisted = await persistMessage(snippetId, "assistant", "text", block.text);
          lastAssistantText = block.text.trim();
          if (persisted.type === "message") {
            lastAssistantId = persisted.id;
          }
          emit(snippetId, persisted);
        } else if (block.type === "tool_use") {
          const summary = `${String(block.name ?? "tool")} ${JSON.stringify(block.input ?? {})}`;
          const toolUseId = typeof block.id === "string" ? block.id : null;
          emit(snippetId, await persistMessage(snippetId, "assistant", "tool_use", summary, toolUseId));
        }
      }
      return;
    }
    if (event.type === "user") {
      // Tool results come back as a user-role message with tool_result blocks.
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === "tool_result") {
          const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
          emit(snippetId, await persistMessage(snippetId, "tool", "tool_result", toolResultText(block.content), toolUseId));
        }
      }
      return;
    }
    if (event.type === "result") {
      // The turn is over, so no interrupt can arrive any more: close stdin and the
      // process exits. Keeping it open is what stream-json input costs us — the CLI
      // waits for further messages and never exits on its own.
      if (child.stdin?.writable) {
        child.stdin.end();
      }
      const isError = Boolean(event.is_error);
      const text = typeof event.result === "string" ? event.result : "";
      if (!isError && text.trim()) finalText = text;
      // A resume can fail if the session transcript is missing (e.g. it was
      // created under a different config dir). We retry once as a fresh session.
      const willRetry = isError && resume && !resumeRetried && /no conversation found|session id/i.test(text);
      // Accumulate this turn's usage onto the snippet (tokens, duration, turns),
      // but not for a failed attempt we're about to retry — else the failed try
      // and the fresh-session retry would both count against the snippet totals.
      const usage = willRetry ? null : turnUsage(event);
      if (usage) {
        await recordUsage(snippetId, usage);
      }
      // The result event repeats the final assistant text. Only persist it when
      // it differs from the last assistant message (else the reply shows twice);
      // otherwise reuse that message as the anchor for parsed proposals.
      let resultMessageId: string | null = lastAssistantId;
      if (!isError && text.trim() && text.trim() !== lastAssistantText) {
        const message = await persistMessage(snippetId, "assistant", "result", text);
        if (message.type === "message") {
          resultMessageId = message.id;
        }
        emit(snippetId, message);
      }
      // The turn's cost belongs to the reply the reader sees, which is either the
      // result message just written or the last streamed assistant message.
      if (usage && resultMessageId) {
        await recordMessageUsage(resultMessageId, usage);
      }
      if (isError) {
        // Rather than dead-end the thread, restart as a fresh session (below).
        if (willRetry) {
          resumeFallback = true;
          return;
        }
        // Defer the one persisted failure until `close`, where stderr and the
        // process exit are available too. An interrupt we requested is a stop,
        // not a failure, even though Claude marks its result as `is_error`.
        if (!handle.stopRequested) {
          failedResultEvent = event;
        }
      } else if (text) {
        // Parse any proposed library changes and enqueue them for approval.
        const { operations, errors } = parseProposalsResult(text);
        for (const operation of operations) {
          emit(snippetId, await persistProposal(snippetId, resultMessageId, operation));
        }
        // A proposal that failed validation used to disappear without a trace,
        // leaving the user with an agent that claimed to have proposed a change
        // and no card to approve. Record it in the thread instead.
        if (errors.length) {
          emit(
            snippetId,
            await persistMessage(
              snippetId,
              "system",
              "error",
              `Ignored ${errors.length} malformed proposal${errors.length === 1 ? "" : "s"}: ${errors.join(" | ")}`,
            ),
          );
        }
      }
    }
  };

  // stream-json lines must be persisted in arrival order. Dispatching each
  // async handler with `void` let `close` mark the feed Done while earlier tool
  // results were still awaiting storage; a refresh then revealed "new" output.
  let eventQueue: Promise<void> = Promise.resolve();
  let eventQueueError: string | null = null;
  const enqueueLine = (line: string) => {
    eventQueue = eventQueue
      .then(() => handleLine(line))
      .catch((error: unknown) => {
        eventQueueError ??= error instanceof Error ? error.message : String(error);
      });
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      enqueueLine(line);
      index = buffer.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  // Release the run slot only if THIS handle still owns it. If a later turn
  // (e.g. after a stop-timeout) already replaced the entry, we must not evict
  // its handle or revoke its token when our stale process finally exits.
  const releaseRun = () => {
    if (runs.get(snippetId) === handle) {
      runs.delete(snippetId);
      revokeFeedToken(snippetId);
    }
  };

  const finishError = async ({
    resultEvent = failedResultEvent,
    processError,
    code,
    signal,
  }: {
    resultEvent?: Record<string, unknown> | null;
    processError?: string;
    code?: number | null;
    signal?: string | null;
  }): Promise<void> => {
    if (terminalSettled) return;
    terminalSettled = true;
    const detail = formatAgentFailure({ resultEvent, stderr, processError, code, signal });
    emit(snippetId, await persistMessage(snippetId, "system", "error", detail));
    await setStatus(snippetId, "error", detail);
    emit(snippetId, { type: "done", status: "error" });
    settle({ status: "error", text: "", error: detail });
  };

  child.on("error", async (error) => {
    await finishError({ processError: error.message });
    releaseRun();
  });

  child.on("close", async (code, signal) => {
    if (buffer.trim()) {
      enqueueLine(buffer);
      buffer = "";
    }
    await eventQueue;
    if (eventQueueError && !terminalSettled) {
      await finishError({ processError: `Agent output could not be saved: ${eventQueueError}`, code, signal });
      releaseRun();
      return;
    }
    if (terminalSettled) {
      releaseRun();
      return;
    }

    // The resume failed with a missing-session error: restart this turn as a
    // fresh session seeded with the thread transcript, so the reply still lands.
    // Chain the retry's outcome to this turn's completion so an awaiting caller
    // sees the final result, not the transient failure.
    if (resumeFallback) {
      terminalSettled = true;
      const transcript = await threadTranscript(snippetId);
      const freshPrompt = buildForkPrompt({ reply: prompt, transcript });
      await clearSessionId(snippetId);
      releaseRun();
      runFeedAgent({ snippetId, sessionId: crypto.randomUUID(), prompt: freshPrompt, resume: false, resumeRetried: true })
        .then(settle, (error) => settle({ status: "error", text: "", error: error instanceof Error ? error.message : String(error) }));
      return;
    }

    // 143 = 128 + SIGTERM, which is what the CLI exits with when it traps the
    // signal instead of dying from it; 137 is the SIGKILL equivalent.
    // The flag comes off THIS handle so it remains reliable even if another run
    // later replaces the map entry.
    const stopped = isStoppedExit({ code, signal, stopRequested: handle.stopRequested });
    const status = stopped ? "stopped" : code === 0 && !failedResultEvent ? "done" : "error";
    if (status === "error") {
      await finishError({ code, signal });
      releaseRun();
      return;
    }
    if (terminalSettled) return;
    terminalSettled = true;
    await setStatus(snippetId, status);
    // Emit the terminal event so live subscribers (the SSE stream) can close.
    emit(snippetId, { type: "done", status });
    settle({ status, text: finalText, error: undefined });
    releaseRun();
  });

  return completion;
}
