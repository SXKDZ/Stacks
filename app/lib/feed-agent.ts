import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { libraryRoot } from "@/db/library-paths";
import { feedMessages, feedProposals, feedSnippets } from "@/db/schema";
import { resolveRuntimeValues, runtimeValue } from "@/app/lib/runtime-config";
import { buildForkPrompt, parseProposals, type ProposalOperation } from "@/app/lib/feed-prompt";
import { issueFeedToken, revokeFeedToken } from "@/app/lib/feed-token";

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

const MAX_TURNS = "40";
const CLAUDE_BIN = process.env.STACKS_CLAUDE_BIN?.trim() || "claude";

interface RunHandle {
  child: ChildProcess;
  subscribers: Set<(event: FeedEvent) => void>;
}

/** The outcome of a single agent turn, resolved when its process exits. */
export interface AgentTurnResult {
  status: "done" | "error" | "stopped";
  /** The agent's final assistant/result text (empty on error/stop). */
  text: string;
  error?: string;
}

const runs = new Map<string, RunHandle>();

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function feedWorkingDir(snippetId: string): string {
  return join(libraryRoot(), "feed", snippetId);
}

/** Flatten a tool_result content field (string, or array of text blocks) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content.slice(0, 4000);
  }
  if (Array.isArray(content)) {
    const text = content
      .map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
    return text.slice(0, 4000);
  }
  return "";
}

export function isFeedRunning(snippetId: string): boolean {
  return runs.has(snippetId);
}

/** Subscribe to live events for a running snippet; returns an unsubscribe fn. */
export function subscribeFeed(snippetId: string, listener: (event: FeedEvent) => void): () => void {
  const handle = runs.get(snippetId);
  if (!handle) {
    return () => {};
  }
  handle.subscribers.add(listener);
  return () => handle.subscribers.delete(listener);
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

export async function stopFeed(snippetId: string): Promise<void> {
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
  return { type: "proposal", id, messageId, operation: serialized, status: "pending", summary: operation.summary ?? "Proposed change", createdAt };
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

/** Accumulate a turn's usage from the stream-json `result` event. Tokens sum
 *  across cache + input/output; duration and turn count add up over follow-ups. */
async function recordUsage(snippetId: string, event: Record<string, unknown>): Promise<void> {
  const usage = (event.usage ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const inputTokens = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
  const outputTokens = num(usage.output_tokens);
  const durationMs = num(event.duration_ms);
  const turns = num(event.num_turns) || 1;
  if (!inputTokens && !outputTokens && !durationMs) {
    return;
  }
  const database = await ensureDatabase();
  database
    .update(feedSnippets)
    .set({
      inputTokens: sql`${feedSnippets.inputTokens} + ${inputTokens}`,
      outputTokens: sql`${feedSnippets.outputTokens} + ${outputTokens}`,
      durationMs: sql`${feedSnippets.durationMs} + ${durationMs}`,
      turns: sql`${feedSnippets.turns} + ${turns}`,
    })
    .where(eq(feedSnippets.id, snippetId))
    .run();
}

function emit(snippetId: string, event: FeedEvent): void {
  const handle = runs.get(snippetId);
  handle?.subscribers.forEach((listener) => {
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
    const snippetModel = database
      .select({ model: feedSnippets.model })
      .from(feedSnippets)
      .where(eq(feedSnippets.id, snippetId))
      .get()?.model?.trim();

    // Resolve the environment (secrets, config dir) before spawn so no await
    // sits between spawn() and the listener attachment below.
    const env = await agentEnv(issueFeedToken(snippetId));

    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      MAX_TURNS,
      "--add-dir",
      workingDir,
      ...(snippetModel ? ["--model", snippetModel] : []),
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
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The agent could not be started.";
    revokeFeedToken(snippetId);
    await persistMessage(snippetId, "system", "error", message);
    await setStatus(snippetId, "error", message);
    emit(snippetId, { type: "done", status: "error" });
    return { status: "error", text: "", error: message };
  }

  const handle: RunHandle = { child, subscribers: new Set() };
  runs.set(snippetId, handle);

  let buffer = "";
  let stderr = "";
  let sessionCaptured = resume;
  let lastAssistantText = "";
  let lastAssistantId: string | null = null;
  // The final result text of this turn, surfaced to awaiting callers.
  let finalText = "";
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
          const summary = `${String(block.name ?? "tool")} ${JSON.stringify(block.input ?? {}).slice(0, 800)}`;
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
      const isError = Boolean(event.is_error);
      const text = typeof event.result === "string" ? event.result : "";
      if (!isError && text.trim()) finalText = text;
      // A resume can fail if the session transcript is missing (e.g. it was
      // created under a different config dir). We retry once as a fresh session.
      const willRetry = isError && resume && !resumeRetried && /no conversation found|session id/i.test(text);
      // Accumulate this turn's usage onto the snippet (tokens, duration, turns),
      // but not for a failed attempt we're about to retry — else the failed try
      // and the fresh-session retry would both count against the snippet totals.
      if (!willRetry) {
        await recordUsage(snippetId, event);
      }
      // The result event repeats the final assistant text. Only persist it when
      // it differs from the last assistant message (else the reply shows twice);
      // otherwise reuse that message as the anchor for parsed proposals.
      let resultMessageId: string | null = lastAssistantId;
      if (text.trim() && text.trim() !== lastAssistantText) {
        const message = await persistMessage(snippetId, "assistant", "result", text);
        if (message.type === "message") {
          resultMessageId = message.id;
        }
        emit(snippetId, message);
      }
      if (isError) {
        // Rather than dead-end the thread, restart as a fresh session (below).
        if (willRetry) {
          resumeFallback = true;
          return;
        }
        emit(snippetId, await persistMessage(snippetId, "system", "error", text || "The agent reported an error."));
      } else if (text) {
        // Parse any proposed library changes and enqueue them for approval.
        for (const operation of parseProposals(text)) {
          emit(snippetId, await persistProposal(snippetId, resultMessageId, operation));
        }
      }
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      void handleLine(line);
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

  child.on("error", async (error) => {
    releaseRun();
    await persistMessage(snippetId, "system", "error", error.message);
    await setStatus(snippetId, "error", error.message);
    emit(snippetId, { type: "done", status: "error" });
    settle({ status: "error", text: "", error: error.message });
  });

  child.on("close", async (code, signal) => {
    if (buffer.trim()) {
      await handleLine(buffer);
    }
    releaseRun();

    // The resume failed with a missing-session error: restart this turn as a
    // fresh session seeded with the thread transcript, so the reply still lands.
    // Chain the retry's outcome to this turn's completion so an awaiting caller
    // sees the final result, not the transient failure.
    if (resumeFallback) {
      const transcript = await threadTranscript(snippetId);
      const freshPrompt = buildForkPrompt({ reply: prompt, transcript });
      await clearSessionId(snippetId);
      runFeedAgent({ snippetId, sessionId: crypto.randomUUID(), prompt: freshPrompt, resume: false, resumeRetried: true })
        .then(settle, (error) => settle({ status: "error", text: "", error: error instanceof Error ? error.message : String(error) }));
      return;
    }

    const stopped = signal === "SIGTERM" || signal === "SIGKILL";
    const status = stopped ? "stopped" : code === 0 ? "done" : "error";
    if (status === "error") {
      const detail = stderr.trim().slice(-500) || `The agent exited with code ${code}.`;
      await persistMessage(snippetId, "system", "error", detail);
      await setStatus(snippetId, "error", detail);
      emit(snippetId, { type: "done", status });
      settle({ status: "error", text: "", error: detail });
      return;
    }
    await setStatus(snippetId, status);
    // Emit the terminal event so live subscribers (the SSE stream) can close.
    emit(snippetId, { type: "done", status });
    settle({ status, text: finalText, error: undefined });
  });

  return completion;
}
