import test from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libDir = mkdtempSync(join(tmpdir(), "wfrev-"));
process.env.STACKS_LIBRARY_DIR = libDir;
const stub = join(libDir, "fake-claude.sh");
writeFileSync(stub, `#!/bin/sh\nif [ -n "$STACKS_STUB_TRACE" ]; then printf 'S %s\\n' "$STACKS_FEED_TOKEN" >> "$STACKS_STUB_TRACE"; fi\nsleep \${STACKS_STUB_SLEEP:-0}\nif [ -n "$STACKS_STUB_TRACE" ]; then printf 'E\\n' >> "$STACKS_STUB_TRACE"; fi\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"OK"}'\n`);
chmodSync(stub, 0o755);
process.env.STACKS_CLAUDE_BIN = stub;

const { readWorkflowMeta, runWorkflow } = await import("../../app/lib/workflow-runtime.ts");
const { ensureDatabase } = await import("../../db/bootstrap.ts");
const { feedMessages, feedSnippets } = await import("../../db/schema.ts");
const { asc, eq } = await import("drizzle-orm");
const db = await ensureDatabase();

const seed = (id: string) => {
  const now = new Date().toISOString();
  db.insert(feedSnippets).values({ id, title: "t", instruction: "i", status: "queued", sessionId: "", createdAt: now, updatedAt: now }).run();
};
const msgs = (id: string) => db.select().from(feedMessages).where(eq(feedMessages.snippetId, id)).orderBy(asc(feedMessages.createdAt)).all().map((m) => m.content);

test("probe: capability matrix", () => {
  const probe = (expr: string) => readWorkflowMeta(`export const meta = { name: "n", description: String(${expr}) };`)?.description;
  for (const n of ["require","process","globalThis.process","setTimeout","setInterval","queueMicrotask","Buffer","fetch","crypto","URL","TextEncoder","structuredClone","performance","Date","module","global","Reflect","Proxy","WeakRef","Atomics","SharedArrayBuffer","Intl","eval"]) {
    console.log("typeof", n, "=", probe(`typeof ${n}`));
  }
  console.log("keys:", probe(`Object.keys(Function("return this")()).join(",")`));
  console.log("ownkeys:", probe(`Object.getOwnPropertyNames(Function("return this")()).length`));
  console.log("objctor:", probe(`({}).constructor.constructor("return typeof process")()`));
  console.log("Date.now:", probe(`(() => { try { Date.now(); return "worked"; } catch (e) { return e.constructor.name + "|" + e.message; } })()`));
  console.log("Math.random:", probe(`typeof Math.random()`));
  console.log("fnthis.process:", probe(`typeof Function("return this")().process`));
});

test("probe: escape via injected primitive", () => {
  const target = join(libDir, "escaped.txt");
  const m = readWorkflowMeta(`export const meta = { name: "n", description: "d" };\nconst P = log.constructor.constructor("return process")();\nP.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(target)}, "escaped");\nglobalThis.__hostver = P.version;`);
  console.log("meta:", JSON.stringify(m), "wrote:", existsSync(target), existsSync(target) ? readFileSync(target, "utf8") : "");
  for (const name of ["log", "phase", "agent", "parallel", "pipeline", "console.log"]) {
    const r = readWorkflowMeta(`export const meta = { name: "n", description: String(typeof ${name}.constructor.constructor("return process")().pid) };`);
    console.log("pid via", name, "=", r?.description);
  }
});

test("probe: top-level await + starter", () => {
  const STARTER = `export const meta = {\n  name: 'Tag untagged papers',\n  description: 'Suggest a collection for each paper that has none',\n}\n\nphase('Scan')\nconst result = await agent(\n  'List papers in my library that are not in any collection, then propose ' +\n  'adding each to a fitting collection (create one if needed).',\n)\nlog('Proposed collection changes. Approve them above.')\n`;
  console.log("starter meta:", JSON.stringify(readWorkflowMeta(STARTER)));
  console.log("tla min:", JSON.stringify(readWorkflowMeta(`export const meta = { name: "a", description: "b" };\nawait agent("x");`)));
  console.log("iife:", JSON.stringify(readWorkflowMeta(`export const meta = { name: "a", description: "b" };\n(async () => { await agent("x"); })();`)));
});

test("probe: meta getter flip + rejection matrix + comment", () => {
  console.log("flip:", JSON.stringify(readWorkflowMeta(`let n = 0;\nexport const meta = { get name() { n++; return n === 1 ? "str" : { evil: 1 }; }, description: "d" };`)));
  const rejects = [`log("no meta");`, `export const meta = { name: "x", description: "y" ;;;`, `export const meta = "hello";`, `export const meta = { name: 5, description: "d" };`, `export const meta = { name: "n", description: null };`, `export default { name: "n", description: "d" };`, `export const meta = { name: "a", description: "b" };\nexport function helper() {}`, `import fs from "node:fs";\nexport const meta = { name: "a", description: "b" };`, ``, `   `];
  rejects.forEach((s, i) => console.log("reject", i, JSON.stringify(readWorkflowMeta(s))));
  console.log("comment:", JSON.stringify(readWorkflowMeta(`/* Template: export const meta = { name, description } */\nexport const meta = { name: "Real", description: "d" };`)));
  console.log("sentinel:", JSON.stringify(readWorkflowMeta(`globalThis.__meta = { name: "sneaky", description: "d" };`)));
  console.log("positive:", JSON.stringify(readWorkflowMeta(`export const meta = { name: "Triage", description: "T", phases: [{ title: "scan" }, { title: "act", detail: "apply" }] };\nlog("x");`)));
  console.log("strip:", JSON.stringify(readWorkflowMeta(`export const meta = { name: "n", description: "d", phases: "notanarray", evil: 1, id: "z" };`)));
  console.log("ws:", JSON.stringify(readWorkflowMeta(`export    const   meta   = { name: "sp", description: "d" };`)));
  console.log("computed:", JSON.stringify(readWorkflowMeta(`const n = "a" + "b";\nexport const meta = { name: n, description: "d" };`)));
});

test("probe: args escape + proto pollution", async () => {
  seed("esc-args"); seed("esc-proto");
  delete process.env.STACKS_ARGS_PWNED;
  await runWorkflow({ snippetId: "esc-args", args: { foo: 1 }, script: `export const meta = { name: "n", description: "d" };\ntry { args.constructor.constructor("return process")().env.STACKS_ARGS_PWNED = "yes"; log("ESCAPED"); } catch (e) { log("blocked: " + e.message); }` });
  await new Promise((r) => setTimeout(r, 200));
  console.log("args pwned:", process.env.STACKS_ARGS_PWNED, "msgs:", JSON.stringify(msgs("esc-args")));
  delete process.env.STACKS_ARGS_PWNED;
  await runWorkflow({ snippetId: "esc-proto", script: `export const meta = { name: "n", description: "d" };\nlog.constructor.constructor("Object.prototype.__stacksPwned = 42")();` });
  console.log("proto:", (Object.prototype as Record<string, unknown>).__stacksPwned, ({} as Record<string, unknown>).__stacksPwned);
  delete (Object.prototype as Record<string, unknown>).__stacksPwned;
  // control: realm-native pollution
  seed("esc-proto2");
  await runWorkflow({ snippetId: "esc-proto2", script: `export const meta = { name: "n", description: "d" };\nObject.prototype.__x = 1;` });
  console.log("realm-native proto leak:", (Object.prototype as Record<string, unknown>).__x);
});

test("probe: realmResult", async () => {
  seed("realm");
  await runWorkflow({ snippetId: "realm", script: `export const meta = { name: "n", description: "d" };\nconst arr = await parallel([() => 1, () => { throw new Error("x"); }]);\nlog("parallel:" + JSON.stringify(arr));\nlog("arr-escape:" + (() => { try { return typeof arr.constructor.constructor("return process")().pid; } catch (e) { return "blocked:" + e.message; } })());\nconst pipe = await pipeline([1, 2], async (v) => v * 2);\nlog("pipeline:" + JSON.stringify(pipe));\nphase("Phase One");\ntry { await parallel("nope"); } catch (e) { log("parallel-type:" + e.message); }\ntry { await agent("   "); } catch (e) { log("agent-empty:" + e.message); }` });
  await new Promise((r) => setTimeout(r, 300));
  console.log("realm msgs:", JSON.stringify(msgs("realm")), "status:", db.select().from(feedSnippets).where(eq(feedSnippets.id, "realm")).get()?.status);
});
