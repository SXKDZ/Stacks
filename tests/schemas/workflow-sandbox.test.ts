/**
 * The workflow script sandbox.
 *
 * Workflow scripts are user-authored JavaScript executed on the server, and
 * reading a saved workflow's `meta` runs its body, so merely SAVING one used to
 * be enough to escape. The escape was real: an injected host function's
 * `.constructor` is the host `Function` constructor, so `log.constructor("return
 * process")()` handed a script the live process (spawn, filesystem, and the
 * server's shared prototypes).
 *
 * Every case below reports its result through `meta.description`, which is the
 * one value the host reads back, so a successful escape is visible rather than
 * silent.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readWorkflowMeta } from "../../app/lib/workflow-runtime.ts";

/** Run a probe script and return what it reported through its description. */
function probe(body: string): string {
  const meta = readWorkflowMeta(
    `export const meta = { name: "probe", description: (() => { ${body} })() };`,
  );
  return meta?.description ?? "(no meta)";
}

test("reads the meta of a normal script", () => {
  const meta = readWorkflowMeta(`export const meta = {
    name: "find-flaky-tests",
    description: "Find flaky tests and propose fixes",
    phases: [{ title: "Scan", detail: "grep logs" }],
  };
  phase("Scan");
  log("scanning");
  `);
  assert.deepEqual(meta, {
    name: "find-flaky-tests",
    description: "Find flaky tests and propose fixes",
    phases: [{ title: "Scan", detail: "grep logs" }],
  });
});

test("returns null when there is no usable meta", () => {
  assert.equal(readWorkflowMeta("const x = 1;"), null);
  assert.equal(readWorkflowMeta("export const meta = { name: 'only a name' };"), null);
  assert.equal(readWorkflowMeta("export const meta = 'not an object';"), null);
  assert.equal(readWorkflowMeta("this is not javascript ("), null);
});

test("no injected primitive leaks the host Function constructor", () => {
  // The core escape. Each primitive is installed as a wrapper compiled inside the
  // vm realm, so its .constructor belongs to the sandbox, not the host.
  const reported = probe(`
    const escaped = [];
    for (const name of ["log", "phase", "agent", "parallel", "pipeline"]) {
      try {
        const F = globalThis[name].constructor;
        const value = F("return process")();
        if (value && value.pid) escaped.push(name);
      } catch (error) { /* blocked, which is the point */ }
    }
    return escaped.length ? "ESCAPED:" + escaped.join(",") : "all blocked";
  `);
  assert.equal(reported, "all blocked");
});

test("a script cannot corrupt the host's shared prototypes", () => {
  probe(`
    try { log.constructor("Object.prototype.__stacksPwned = 1")(); } catch (error) {}
    try { Object.prototype.__stacksPwned2 = 2; } catch (error) {}
    return "done";
  `);
  // The host realm must be untouched: a write here would affect every request the
  // server handles afterwards.
  assert.equal(({} as Record<string, unknown>).__stacksPwned, undefined);
  assert.equal(({} as Record<string, unknown>).__stacksPwned2, undefined);
});

test("the sandbox's own Function constructor reaches nothing host-side", () => {
  // A vm context legitimately has its own Function; what matters is that it can't
  // see the host's process, require, or globals.
  const reported = probe(`
    const F = [].constructor.constructor;
    const reachable = [];
    for (const expression of ["return process", "return require", "return globalThis.process"]) {
      try {
        const value = F(expression)();
        if (value !== undefined) reachable.push(expression);
      } catch (error) { /* throwing is fine */ }
    }
    return reachable.length ? "REACHED:" + reachable.join(",") : "nothing reachable";
  `);
  assert.equal(reported, "nothing reachable");
});

test("host globals are absent from the sandbox", () => {
  assert.equal(probe('return typeof process === "undefined" ? "absent" : "PRESENT";'), "absent");
  assert.equal(probe('return typeof require === "undefined" ? "absent" : "PRESENT";'), "absent");
  assert.equal(probe('try { require("node:fs"); return "PRESENT"; } catch (error) { return "absent"; }'), "absent");
  // Date is withheld deliberately so runs are reproducible.
  assert.equal(probe('return typeof Date === "undefined" ? "absent" : "PRESENT";'), "absent");
});

test("the args value cannot be walked back to the host realm", () => {
  // args arrives from a request body and is rebuilt inside the context, so its
  // constructor chain is realm-native like everything else.
  const reported = probe(`
    try {
      if (typeof args === "undefined") return "args absent during meta read";
      const F = args.constructor.constructor;
      const value = F("return process")();
      return value && value.pid ? "ESCAPED" : "blocked";
    } catch (error) { return "blocked"; }
  `);
  assert.ok(
    reported === "blocked" || reported === "args absent during meta read",
    `args must not expose the host realm, got: ${reported}`,
  );
});

test("a meta getter cannot report two different values", () => {
  // The meta is taken across as JSON, so a getter that returns a string on the
  // first read and an object on the second can't crash the caller or smuggle a
  // live object out of the sandbox.
  const meta = readWorkflowMeta(`
    let reads = 0;
    globalThis.__probeMeta = {
      get name() { reads += 1; return reads > 1 ? { nested: true } : "shifty"; },
      description: "d",
    };
    export const meta = globalThis.__probeMeta;
  `);
  // Either it is rejected or it is a plain string; never an object.
  if (meta) {
    assert.equal(typeof meta.name, "string");
    assert.equal(typeof meta.description, "string");
  }
});

test("a doc comment mentioning the meta export does not break the read", () => {
  // The rewrite used a non-global regex, so it replaced the FIRST textual
  // occurrence: for a script documenting itself with
  // "export const meta = { name, description }" that was the comment, leaving the
  // real export unparseable and the workflow nameless.
  const meta = readWorkflowMeta(`/**
   * Write your workflow with export const meta = { name, description }.
   */
  export const meta = { name: "real", description: "the real one" };`);
  assert.deepEqual(meta, { name: "real", description: "the real one", phases: undefined });

  // Same for a string literal that happens to contain the phrase.
  const fromString = readWorkflowMeta(
    'const hint = "export const meta = ...";\nexport const meta = { name: "n", description: "d" };',
  );
  assert.equal(fromString?.name, "n");
});

test("a script using top-level await still yields its meta", () => {
  // The app's own starter template awaits an agent call. The body is wrapped in an
  // async IIFE so it parses; the meta assignment precedes the first await.
  const meta = readWorkflowMeta(`export const meta = { name: "s", description: "d", phases: [{ title: "A" }] };
  phase("A");
  const result = await agent("do the thing");
  log(result);`);
  assert.equal(meta?.name, "s");
  assert.deepEqual(meta?.phases, [{ title: "A" }]);
});

test("work scheduled in a microtask cannot outlive or block the meta read", () => {
  // An async body means runInContext returns at the first await, so the vm timeout
  // no longer applies: a `.then(() => { while (true) {} })` used to peg the event
  // loop, and a throw in that callback crashed the process as an unhandled
  // rejection. The inert primitives never settle, so such a callback never runs.
  const started = Date.now();
  const meta = readWorkflowMeta(`export const meta = { name: "x", description: "y" };
  agent("a").then(() => { throw new Error("should never run"); });
  parallel([]).then(() => { const end = Date.now() + 5000; while (Date.now() < end) {} });`);
  assert.equal(meta?.name, "x");
  assert.ok(Date.now() - started < 2000, "the read must not wait on script-scheduled work");
});
