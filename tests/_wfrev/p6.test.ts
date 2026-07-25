import test from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libDir = mkdtempSync(join(tmpdir(), "wfrev6-"));
process.env.STACKS_LIBRARY_DIR = libDir;
const stub = join(libDir, "fake-claude.sh");
writeFileSync(stub, `#!/bin/sh\nsleep \${STACKS_STUB_SLEEP:-0}\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"OK"}'\n`);
chmodSync(stub, 0o755);
process.env.STACKS_CLAUDE_BIN = stub;

const { runWorkflow, readWorkflowMeta } = await import("../../app/lib/workflow-runtime.ts");
const wfRoute = await import("../../app/api/feed/workflows/route.ts");
const runRoute = await import("../../app/api/feed/workflows/run/route.ts");
const { ensureDatabase } = await import("../../db/bootstrap.ts");
const { feedMessages, feedSnippets } = await import("../../db/schema.ts");
const { asc, eq } = await import("drizzle-orm");
const db = await ensureDatabase();
const seed = (id: string) => { const now = new Date().toISOString(); db.insert(feedSnippets).values({ id, title: "t", instruction: "i", status: "queued", sessionId: "", createdAt: now, updatedAt: now }).run(); };
const msgs = (id: string) => db.select().from(feedMessages).where(eq(feedMessages.snippetId, id)).orderBy(asc(feedMessages.createdAt)).all().map((m) => m.content);
const row = (id: string) => db.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();
const post = (body: unknown, url = "http://127.0.0.1/api/feed/workflows") => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("run route: getter-flipped description reaches the DB insert", async () => {
  const FLIP = `let n = 0;\nexport const meta = { name: "N", get description() { n++; return n === 1 ? "str" : { evil: 1 }; } };`;
  console.log("meta:", JSON.stringify(readWorkflowMeta(FLIP)), "typeof desc:", typeof readWorkflowMeta(FLIP)?.description);
  const before = existsSync(join(libDir, "feed")) ? readdirSync(join(libDir, "feed")).length : 0;
  const res = await runRoute.POST(post({ script: FLIP }, "http://127.0.0.1/api/feed/workflows/run"));
  console.log("status", res.status, JSON.stringify(await res.json()).slice(0, 200));
  const after = existsSync(join(libDir, "feed")) ? readdirSync(join(libDir, "feed")).length : 0;
  console.log("feed dirs before/after", before, after);
  console.log("rows", db.select().from(feedSnippets).all().length);
});

test("save route: no cap on id length or entry count", async () => {
  const script = `export const meta = { name: "n", description: "d" };`;
  const b = await (await wfRoute.POST(post({ workflows: [{ id: "I".repeat(100000), script }] }))).json();
  console.log("id len stored", b.workflows[0].id.length);
  const many = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, script }));
  const t0 = Date.now();
  const b2 = await (await wfRoute.POST(post({ workflows: many }))).json();
  console.log("500 entries stored", b2.workflows.length, "ms", Date.now() - t0, "settings bytes", readFileSync(join(libDir, "settings.json"), "utf8").length);
  const dup = await (await wfRoute.POST(post({ workflows: [{ id: "dup", script }, { id: "dup", script: `export const meta = { name: "second", description: "d" };` }] }))).json();
  console.log("dups", JSON.stringify(dup.workflows.map((w: any) => [w.id, w.name])));
});

test("post-await loop: bigger loop timing", async () => {
  seed("loop2");
  const t0 = Date.now();
  await runWorkflow({ snippetId: "loop2", script: `export const meta = { name: "n", description: "d" };\nawait agent("go");\nlet i = 0; while (i < 5e9) i += 1;\nlog("loop-completed");` });
  await new Promise((r) => setTimeout(r, 200));
  console.log("5e9 elapsed", Date.now() - t0, "msgs", JSON.stringify(msgs("loop2")), "status", row("loop2")?.status);
});

test("mid-run delete: listener kept until settle", async () => {
  seed("mid2");
  const captured: string[] = [];
  const onR = (r: unknown) => captured.push(r instanceof Error ? r.message : String(r));
  process.on("unhandledRejection", onR);
  process.env.STACKS_STUB_SLEEP = "0.3";
  let outcome = "pending";
  const p = runWorkflow({ snippetId: "mid2", script: `export const meta = { name: "n", description: "d" };\nawait agent("go");\nlog("after-delete");` }).then(() => { outcome = "resolved"; }, (e) => { outcome = "rejected:" + (e as Error).message; });
  setTimeout(() => db.delete(feedSnippets).where(eq(feedSnippets.id, "mid2")).run(), 120);
  await p;
  await new Promise((r) => setTimeout(r, 800));
  delete process.env.STACKS_STUB_SLEEP;
  console.log("outcome", outcome, "unhandled", captured.length, captured);
  process.off("unhandledRejection", onR);
});
