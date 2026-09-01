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

/**
 * Turn a script's `export const meta = ...` into an assignment the sandbox can
 * read back, without being fooled by the same text appearing elsewhere.
 *
 * A plain `String.replace` with a non-global regex rewrites the FIRST textual
 * occurrence, which for a script whose doc comment mentions
 * `export const meta = { name, description }` was the comment: the real export
 * kept its `export` keyword, failed to parse, and the workflow showed up with no
 * name. Comments and string literals are blanked before the match is located, so
 * only real code is rewritten.
 */
function rewriteMetaExport(script: string): string {
  // A mask where every comment and string literal is replaced by spaces, so
  // offsets still line up with the original text.
  const mask = script
    .replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length))
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (match) => " ".repeat(match.length));
  const found = /export\s+const\s+meta\s*=/.exec(mask);
  if (!found) {
    return script;
  }
  return script.slice(0, found.index) + "globalThis.__meta =" + script.slice(found.index + found[0].length);
}

/** Pull the `meta` object out of a workflow script without running it, so the
 *  UI can list a saved workflow by name/description. Uses the sandbox with the
 *  primitives stubbed to no-ops, then reads the exported meta. Returns null if
 *  the script has no valid meta literal. */
export function readWorkflowMeta(script: string): WorkflowMeta | null {
  try {
    const sandbox = makeSandbox({ metaOnly: true });
    // Only inert values go on the context directly; the callable primitives are
    // installed as realm-native wrappers so the script can't walk back to the
    // host Function constructor through one of them.
    const { agent, parallel, pipeline, log, phase, ...inert } = sandbox;
    const context = vm.createContext(inert);
    installPrimitives(context, { agent, parallel, pipeline, log, phase });
    // Wrap so a top-level `export const meta = {...}` parses as an assignment, and
    // wrap the body in an async IIFE so a script using top-level await (which the
    // app's own starter template does) still yields its meta. The meta literal
    // must be assigned BEFORE the first await, which is the documented rule.
    const wrapped = `(async () => {\n${rewriteMetaExport(script)}\n})();`;
    // An async body means runInContext returns at the first await, so the vm
    // timeout stops applying and a rejection would surface later as an unhandled
    // rejection that kills the process. Swallow both here: this is a metadata
    // read, and anything the script does after its meta assignment is irrelevant.
    const result = vm.runInContext(wrapped, context, { timeout: 1000 }) as unknown;
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      void (result as Promise<unknown>).catch(() => {});
    }
    // Read the meta back through the context (the sandbox object is no longer the
    // context's global, since the primitives are installed inside the realm), and
    // take it across as JSON so a getter cannot hand back a different value on a
    // second read, and so no vm-realm object is retained by the host.
    const encoded = vm.runInContext(
      "JSON.stringify(globalThis.__meta ?? null)",
      context,
      { timeout: 1000 },
    ) as string;
    const meta = JSON.parse(encoded) as WorkflowMeta | null;
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

/**
 * Install host functions into a vm context behind realm-native wrappers.
 *
 * Injecting a host function directly hands the script a HOST-realm object, and
 * `hostFn.constructor` is then the host `Function` constructor: a script could do
 * `log.constructor("return process")()` to reach the real process (spawn a
 * command, read files, write the server's shared Object.prototype). That was
 * reachable, and reachable during a mere SAVE, since reading a workflow's meta
 * executes its body.
 *
 * The wrappers are compiled INSIDE the context and close over the host functions
 * passed as arguments, so nothing host-realm is left on the global object for a
 * script to reach.
 */
function installPrimitives(context: vm.Context, primitives: Record<string, unknown>): void {
  const names = Object.keys(primitives);
  // Parameter names are prefixed so the wrapper can shadow-free reference them.
  const params = names.map((name) => `host_${name}`);
  const body = names
    .map((name) => `  globalThis["${name}"] = function ${name}(...args) { return host_${name}(...args); };`)
    .join("\n");
  const installer = vm.runInContext(
    `(function (${params.join(", ")}) {\n${body}\n})`,
    context,
    { timeout: 1000 },
  ) as (...values: unknown[]) => void;
  installer(...names.map((name) => primitives[name]));
}

/**
 * Re-create the caller's `args` value inside the vm realm.
 *
 * Assigning the host object directly would let a script reach the host realm via
 * `args.constructor` (the same escape as an injected host function). Round-tripping
 * through JSON inside the context yields a realm-native structure; `args` came
 * from a JSON request body, so nothing is lost.
 */
function installArgs(context: vm.Context, args: unknown): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(args ?? null);
  } catch {
    encoded = "null";
  }
  const install = vm.runInContext(
    "(function (json) { globalThis.args = JSON.parse(json); })",
    context,
    { timeout: 1000 },
  ) as (json: string) => void;
  install(encoded);
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
    //
    // They must never return a HOST promise: a script can attach `.then(...)` to
    // one, and that callback then runs on the host microtask queue, where a throw
    // (or a `while(true)`) escapes both the try/catch and the vm timeout. Returning
    // a never-settling promise means such a callback is never invoked at all, which
    // is right for a metadata read: only the meta assignment matters, and the
    // documented rule is that it precedes any await.
    const pending = () => new Promise(() => {});
    base.agent = pending;
    base.parallel = pending;
    base.pipeline = pending;
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
  const { agent, parallel, pipeline, log, phase, ...inert } = sandbox;
  Object.assign(context, inert);
  installPrimitives(context, { agent, parallel, pipeline, log, phase });
  // `args` is data the script reads, but a host OBJECT also exposes the host
  // realm through its constructor, so it is rebuilt inside the context from its
  // JSON form (it arrived as JSON from the request body anyway).
  installArgs(context, args);
  // Strip the `export` from meta (already parsed) and run the body in an async
  // wrapper so top-level await works.
  const body = script.replace(/export\s+const\s+meta\s*=/, "const meta =");
  const wrapped = `(async () => {\n${body}\n})()`;

  try {
    await vm.runInContext(wrapped, context, { timeout: 30 * 60 * 1000 });
    await setStatus(snippetId, "done");
    await postSystem(snippetId, "Workflow finished.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await postSystem(snippetId, `Workflow error: ${message}`);
    await setStatus(snippetId, "error", message);
  }
}
