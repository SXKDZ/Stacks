import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libDir = mkdtempSync(join(tmpdir(), "wfrev3-"));
process.env.STACKS_LIBRARY_DIR = libDir;
const stub = join(libDir, "fake-claude.sh");
writeFileSync(stub, `#!/bin/sh\nif [ -n "$STACKS_STUB_TRACE" ]; then printf 'S\\n' >> "$STACKS_STUB_TRACE"; fi\nif [ -n "$STACKS_STUB_SLEEP" ]; then sleep "$STACKS_STUB_SLEEP"; fi\nif [ -n "$STACKS_STUB_TRACE" ]; then printf 'E\\n' >> "$STACKS_STUB_TRACE"; fi\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"OK"}'\n`);
chmodSync(stub, 0o755);
process.env.STACKS_CLAUDE_BIN = stub;

const { readWorkflowMeta, runWorkflow } = await import("../../app/lib/workflow-runtime.ts");
const { ensureDatabase } = await import("../../db/bootstrap.ts");
const { feedMessages, feedSnippets } = await import("../../db/schema.ts");
const { asc, eq } = await import("drizzle-orm");
const db = await ensureDatabase();
const seed = (id: string) => { const now = new Date().toISOString(); db.insert(feedSnippets).values({ id, title: "t", instruction: "i", status: "queued", sessionId: "", createdAt: now, updatedAt: now }).run(); };
const msgs = (id: string) => db.select().from(feedMessages).where(eq(feedMessages.snippetId, id)).orderBy(asc(feedMessages.createdAt)).all().map((m) => m.content);
const row = (id: string) => db.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();

test("generic leak probe: which globals expose the host Function ctor", () => {
  const expr = `Object.keys(Function("return this")()).filter((k) => { const g = Function("return this")(); const v = g[k]; try { const c = typeof v === "function" ? v.constructor.constructor : (v && v.constructor && v.constructor.constructor); return c ? typeof c("return process")().pid === "number" : false; } catch (e) { return false; } }).join(",")`;
  console.log("metaOnly leaky:", JSON.stringify(readWorkflowMeta(`export const meta = { name: "n", description: ${expr} };`)?.description));
});

test("generic leak probe in RUN context", async () => {
  seed("leak-run");
  const expr = `Object.keys(Function("return this")()).filter((k) => { const g = Function("return this")(); const v = g[k]; try { const c = typeof v === "function" ? v.constructor.constructor : (v && v.constructor && v.constructor.constructor); return c ? typeof c("return process")().pid === "number" : false; } catch (e) { return false; } }).join(",")`;
  await runWorkflow({ snippetId: "leak-run", args: { a: 1 }, script: `export const meta = { name: "n", description: "d" };\nlog("leaky:" + ${expr});\nlog("keys:" + Object.keys(Function("return this")()).join(","));` });
  await new Promise((r) => setTimeout(r, 200));
  console.log(JSON.stringify(msgs("leak-run")));
});

test("stall: never-settling promise", async () => {
  seed("stall");
  const p = runWorkflow({ snippetId: "stall", script: `export const meta = { name: "n", description: "d" };\nawait new Promise(() => {});` }).then(() => "settled");
  const outcome = await Promise.race([p, new Promise((r) => setTimeout(() => r("still-running"), 1500))]);
  console.log("outcome", outcome, "status", row("stall")?.status, "err", row("stall")?.error);
});

test("post-await busy loop", async () => {
  seed("post-await-loop");
  const t0 = Date.now();
  const outcome = await Promise.race([
    runWorkflow({ snippetId: "post-await-loop", script: `export const meta = { name: "n", description: "d" };\nawait agent("go");\nlet i = 0; while (i < 5e8) i += 1;\nlog("loop-completed");` }).then(() => "settled"),
    new Promise((r) => setTimeout(() => r("watchdog"), 2500)),
  ]);
  await new Promise((r) => setTimeout(r, 300));
  console.log("outcome", outcome, Date.now() - t0, "ms msgs", JSON.stringify(msgs("post-await-loop")), "status", row("post-await-loop")?.status);
});

test("microtask escapes meta timeout", async () => {
  const script = `export const meta = { name: "n", description: "d" };\nagent("x").then(() => { let i = 0; while (i < 3e9) i += 1; });`;
  const t0 = Date.now();
  const meta = readWorkflowMeta(script);
  const syncMs = Date.now() - t0;
  const t1 = Date.now();
  await new Promise((r) => setTimeout(r, 0));
  console.log("meta", JSON.stringify(meta), "syncMs", syncMs, "drainMs", Date.now() - t1);
});

test("dynamic import unhandled rejection", async () => {
  const seen: unknown[] = [];
  const onR = (r: unknown) => seen.push(r);
  process.on("unhandledRejection", onR);
  const meta = readWorkflowMeta(`export const meta = { name: "n", description: "d" };\nimport("node:fs");`);
  await new Promise((r) => setTimeout(r, 150));
  process.off("unhandledRejection", onR);
  console.log("meta", JSON.stringify(meta), "unhandled", seen.length, seen.map((s) => (s as any)?.code + "|" + (s as any)?.message));
  seed("dyn");
  await runWorkflow({ snippetId: "dyn", script: `export const meta = { name: "n", description: "d" };\nawait import("node:fs");\nlog("after");` });
  await new Promise((r) => setTimeout(r, 200));
  console.log("dyn status", row("dyn")?.status, JSON.stringify(msgs("dyn")), "err", row("dyn")?.error);
});
