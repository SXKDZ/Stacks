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

export async function stopFeed(snippetId: string): Promise<void> {
  const handle = runs.get(snippetId);
  if (handle?.child.pid) {
    try {
      process.kill(-handle.child.pid, "SIGTERM");
    } catch {
      handle.child.kill("SIGTERM");
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
}): Promise<void> {
  const { snippetId, sessionId, prompt, resume, resumeRetried = false } = options;
  const workingDir = feedWorkingDir(snippetId);
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(claudeConfigDir(), { recursive: true });

  // Issue a per-run token the agent uses (via Bash + curl) to reach the
  // agent-facing library APIs. Reads run live; writes enqueue approvals.
  const feedToken = issueFeedToken(snippetId);

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
    // Headless: with no user to answer prompts, the default mode auto-denies
    // every Bash/network/temp-file call, so the agent can't even read the
    // library. "auto" keeps the background safety classifier as a guardrail
    // while letting normal operations run. Library WRITES stay safe regardless:
    // the feed API only queues proposals for the user to approve.
    "--permission-mode",
    "auto",
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
  ];

  const child = spawn(CLAUDE_BIN, args, {
    cwd: workingDir,
    env: await agentEnv(feedToken),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const handle: RunHandle = { child, subscribers: new Set() };
  runs.set(snippetId, handle);
  await setStatus(snippetId, "running");
  emit(snippetId, { type: "status", status: "running" });

  let buffer = "";
  let stderr = "";
  let sessionCaptured = resume;
  let lastAssistantText = "";
  let lastAssistantId: string | null = null;
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
      // Accumulate this turn's usage onto the snippet (tokens, duration, turns).
      await recordUsage(snippetId, event);
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
        // A resume can fail if the session transcript is missing (e.g. it was
        // created under a different config dir). Rather than dead-end the
        // thread, retry once as a fresh session seeded with the transcript.
        if (resume && !resumeRetried && /no conversation found|session id/i.test(text)) {
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

  child.on("error", async (error) => {
    await persistMessage(snippetId, "system", "error", error.message);
    await setStatus(snippetId, "error", error.message);
    emit(snippetId, { type: "done", status: "error" });
    revokeFeedToken(snippetId);
    runs.delete(snippetId);
  });

  child.on("close", async (code, signal) => {
    if (buffer.trim()) {
      await handleLine(buffer);
    }
    revokeFeedToken(snippetId);
    runs.delete(snippetId);

    // The resume failed with a missing-session error: restart this turn as a
    // fresh session seeded with the thread transcript, so the reply still lands.
    if (resumeFallback) {
      const transcript = await threadTranscript(snippetId);
      const freshPrompt = buildForkPrompt({ reply: prompt, transcript });
      await clearSessionId(snippetId);
      void runFeedAgent({ snippetId, sessionId: crypto.randomUUID(), prompt: freshPrompt, resume: false, resumeRetried: true }).catch(() => {});
      return;
    }

    const stopped = signal === "SIGTERM" || signal === "SIGKILL";
    const status = stopped ? "stopped" : code === 0 ? "done" : "error";
    if (status === "error") {
      const detail = stderr.trim().slice(-500) || `The agent exited with code ${code}.`;
      await persistMessage(snippetId, "system", "error", detail);
      await setStatus(snippetId, "error", detail);
    } else {
      await setStatus(snippetId, status);
    }
    // Emit the terminal event so live subscribers (the SSE stream) can close.
    emit(snippetId, { type: "done", status });
  });
}
