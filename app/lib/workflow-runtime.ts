import vm from "node:vm";
import { eq } from "drizzle-orm";
import { ensureDatabase } from "@/db/bootstrap";
import { feedMessages, feedSnippets } from "@/db/schema";
import { runFeedAgent, type AgentTurnResult } from "@/app/lib/feed-agent";

/**
 * Runs a Claude Code workflow script (the `export const meta = {...}` + body
 * form) inside Stacks. The script is plain JS executed in a node:vm context with
 * the workflow primitives injected — `agent()`, `parallel()`, `pipeline()`,
 * `log()`, `phase()`. Each `agent(prompt)` runs a headless `claude -p` turn via
 * the feed runner, so every library write it proposes stays approval-gated
 * exactly like a normal feed. A whole run is one feed thread: its agents' output
 * and proposals stream into that thread and are reviewed there.
 *
 * This is deliberately NOT the harness Workflow tool (Stacks can't call that);
 * it's a compatible runtime so the same script shape runs against your library.
 *
 * SECURITY: node:vm is NOT a sandbox — it does not isolate untrusted code (see
 * the Node docs). A workflow script runs with the full privileges of the Stacks
 * server process: it can reach the filesystem and, via the primitives, the
 * library. Treat a workflow the same as any script you would `node`-run: only
 * run scripts you authored or trust. The context below withholds host-realm
 * intrinsics so a script can't casually reach `process`/`require` or corrupt the
 * server's shared prototypes, but that is hardening, not a trust boundary.
 */

const MAX_CONCURRENT_AGENTS = 4;
const MAX_TOTAL_AGENTS = 200;

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: Array<{ title: string; detail?: string }>;
}

/** Pull the `meta` object out of a workflow script without running it, so the
 *  UI can list a saved workflow by name/description. Uses the sandbox with the
 *  primitives stubbed to no-ops, then reads the exported meta. Returns null if
 *  the script has no valid meta literal. */
export function readWorkflowMeta(script: string): WorkflowMeta | null {
  try {
    const sandbox = makeSandbox({ metaOnly: true });
    const context = vm.createContext(sandbox);
    // Wrap so a top-level `export const meta = {...}` parses as an assignment.
    const wrapped = script.replace(/export\s+const\s+meta\s*=/, "globalThis.__meta =");
    vm.runInContext(wrapped, context, { timeout: 1000 });
    const meta = sandbox.__meta as WorkflowMeta | undefined;
    if (meta && typeof meta.name === "string" && typeof meta.description === "string") {
      return { name: meta.name, description: meta.description, phases: Array.isArray(meta.phases) ? meta.phases : undefined };
    }
    return null;
  } catch {
    return null;
  }
}

interface RunContext {
  snippetId: string;
  log: (message: string) => void;
  phase: (title: string) => void;
  runAgent: (prompt: string, opts?: { label?: string }) => Promise<string>;
}

/** The vm realm's own Array/Promise, so primitive return values are realm-native
 *  and their prototype chain never reaches the host Function constructor. */
interface RealmIntrinsics {
  Array: ArrayConstructor;
  Promise: PromiseConstructor;
}

/** Re-home a host promise into the vm realm and resolve its value through the
 *  realm's Array when it is array-like, closing the return-value escape channel
 *  (`result.constructor.constructor(...)` can no longer reach the host realm). */
function realmResult<T>(realm: RealmIntrinsics, work: Promise<T>): Promise<T> {
  return new realm.Promise<T>((resolve, reject) => {
    work.then(
      (value) => resolve(Array.isArray(value) ? (realm.Array.from(value) as T) : value),
      reject,
    );
  });
}

/** Build the vm globals shared by meta-extraction and execution. When
 *  `metaOnly`, the primitives are inert (never spawn agents). `realm` is the
 *  execution context's own intrinsics (absent during meta read). */
function makeSandbox(
  options: { metaOnly: true } | { metaOnly: false; ctx: RunContext; realm: RealmIntrinsics },
): Record<string, unknown> {
  // Do NOT inject the host realm's JSON/Math/Array/Object/Promise/etc. A vm
  // context already has its own realm's built-ins, so scripts keep working;
  // handing over the host intrinsics instead would expose the host Function
  // constructor (`Object.constructor('return process')()`) and let a script
  // corrupt the server's shared prototypes. Date stays withheld deliberately so
  // runs are deterministic (pass timestamps via args).
  const base: Record<string, unknown> = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    Date: undefined,
    __meta: undefined,
  };
  if (options.metaOnly) {
    // Inert primitives so a script's top-level calls don't throw during meta read.
    base.agent = async () => "";
    base.parallel = async () => [];
    base.pipeline = async () => [];
    base.log = () => {};
    base.phase = () => {};
    return base;
  }
  const { ctx, realm } = options;
  let launched = 0;
  const gate = new Semaphore(MAX_CONCURRENT_AGENTS);
  const agent = (prompt: string, opts?: { label?: string }): Promise<string> =>
    realmResult(realm, (async () => {
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error("agent(prompt) needs a non-empty prompt string.");
      if (launched >= MAX_TOTAL_AGENTS) throw new Error(`Workflow exceeded the ${MAX_TOTAL_AGENTS}-agent cap.`);
      launched += 1;
      return gate.run(() => ctx.runAgent(prompt, opts));
    })());
  const parallel = (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    realmResult(realm, (async () => {
      if (!Array.isArray(thunks)) throw new Error("parallel(thunks) needs an array of functions.");
      return Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)));
    })());
  const pipeline = (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>): Promise<unknown[]> =>
    realmResult(realm, (async () => {
      if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages) needs an array of items.");
      return Promise.all(items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try { value = await stage(value, item, index); } catch { return null; }
        }
        return value;
      }));
    })());
  base.agent = agent;
  base.parallel = parallel;
  base.pipeline = pipeline;
  base.log = (message: string) => ctx.log(String(message));
  base.phase = (title: string) => ctx.phase(String(title));
  return base;
}

/** A tiny concurrency limiter for agent() calls. */
class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

async function setStatus(snippetId: string, status: string, error?: string): Promise<void> {
  const database = await ensureDatabase();
  database.update(feedSnippets).set({ status, error: error ?? null, updatedAt: new Date().toISOString() }).where(eq(feedSnippets.id, snippetId)).run();
}

async function postSystem(snippetId: string, content: string): Promise<void> {
  const database = await ensureDatabase();
  database.insert(feedMessages).values({
    id: `msg-${crypto.randomUUID()}`,
    snippetId,
    role: "system",
    kind: "text",
    content,
    createdAt: new Date().toISOString(),
  }).run();
}

/**
 * Execute a workflow script as the given feed snippet. Each agent() turn runs a
 * fresh claude -p session in the feed thread; proposals it emits queue for
 * approval. Fire-and-forget: the caller returns the snippet id immediately and
 * the thread streams progress.
 */
export async function runWorkflow(options: { snippetId: string; script: string; args?: unknown }): Promise<void> {
  const { snippetId, script, args } = options;
  await setStatus(snippetId, "running");
  await postSystem(snippetId, "Workflow started.");

  const ctx: RunContext = {
    snippetId,
    log: (message) => { void postSystem(snippetId, message); },
    phase: (title) => { void postSystem(snippetId, `## ${title}`); },
    runAgent: async (prompt) => {
      const result: AgentTurnResult = await runFeedAgent({
        snippetId,
        sessionId: crypto.randomUUID(),
        prompt,
        resume: false,
      });
      if (result.status === "error") throw new Error(result.error || "The agent turn failed.");
      return result.text;
    },
  };

  // Create the context first with only inert values, then read its realm's own
  // Array/Promise back out and install the live primitives that use them, so
  // every primitive result is realm-native (see realmResult).
  const context = vm.createContext({ console: { log: () => {}, error: () => {}, warn: () => {} }, Date: undefined });
  const realm = vm.runInContext("({ Array, Promise })", context) as RealmIntrinsics;
  const sandbox = makeSandbox({ metaOnly: false, ctx, realm });
  Object.assign(context, sandbox, { args });
  // Strip the `export` from meta (already parsed) and run the body in an async
  // wrapper so top-level await works.
  const body = script.replace(/export\s+const\s+meta\s*=/, "const meta =");
  const wrapped = `(async () => {\n${body}\n})()`;

  try {
    await vm.runInContext(wrapped, context, { timeout: 30 * 60 * 1000 });
    await setStatus(snippetId, "done");
    await postSystem(snippetId, "Workflow finished. Review any proposed changes above.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await postSystem(snippetId, `Workflow error: ${message}`);
    await setStatus(snippetId, "error", message);
  }
}
