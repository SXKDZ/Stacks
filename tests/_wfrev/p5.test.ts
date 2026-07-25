import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libDir = mkdtempSync(join(tmpdir(), "wfrev5-"));
process.env.STACKS_LIBRARY_DIR = libDir;
const trace = join(libDir, "trace.log");
const stub = join(libDir, "fake-claude.sh");
writeFileSync(stub, `#!/bin/sh\nprintf 'S\\n' >> "${trace}"\nsleep \${STACKS_STUB_SLEEP:-0}\nprintf 'E\\n' >> "${trace}"\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"OK"}'\n`);
chmodSync(stub, 0o755);
process.env.STACKS_CLAUDE_BIN = stub;

const { runWorkflow } = await import("../../app/lib/workflow-runtime.ts");
const { ensureDatabase } = await import("../../db/bootstrap.ts");
const { feedMessages, feedSnippets } = await import("../../db/schema.ts");
const { asc, eq } = await import("drizzle-orm");
const db = await ensureDatabase();
const seed = (id: string) => { const now = new Date().toISOString(); db.insert(feedSnippets).values({ id, title: "t", instruction: "i", status: "queued", sessionId: "", createdAt: now, updatedAt: now }).run(); };
const msgs = (id: string) => db.select().from(feedMessages).where(eq(feedMessages.snippetId, id)).orderBy(asc(feedMessages.createdAt)).all().map((m) => m.content);
const row = (id: string) => db.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();

test("concurrency cap = 4", async () => {
  seed("conc");
  process.env.STACKS_STUB_SLEEP = "0.4";
  writeFileSync(trace, "");
  const t0 = Date.now();
  await runWorkflow({ snippetId: "conc", script: `export const meta = { name: "n", description: "d" };\nconst p = []; for (let i = 0; i < 20; i++) p.push(agent("a" + i));\nawait Promise.all(p);\nlog("done");` });
  delete process.env.STACKS_STUB_SLEEP;
  const seq = readFileSync(trace, "utf8").trim().split("\n");
  let cur = 0, max = 0;
  for (const line of seq) { cur += line === "S" ? 1 : -1; max = Math.max(max, cur); }
  console.log("elapsed", Date.now() - t0, "events", seq.length, "maxConcurrent", max, "status", row("conc")?.status);
});

test("total cap = 200", async () => {
  seed("total");
  const t0 = Date.now();
  await runWorkflow({ snippetId: "total", script: `export const meta = { name: "n", description: "d" };\nlet oks = 0, errs = 0, lastErr = "";\nfor (let i = 0; i < 201; i++) { try { await agent("p" + i); oks++; } catch (e) { errs++; lastErr = e.message; } }\nlog("oks=" + oks + " errs=" + errs);\nlog("CAP ERR: " + lastErr);` });
  await new Promise((r) => setTimeout(r, 300));
  console.log("elapsed", Date.now() - t0, "msgs tail", JSON.stringify(msgs("total").slice(-3)));
});

test("mid-run snippet delete -> unhandled rejections?", async () => {
  seed("mid");
  const captured: unknown[] = [];
  const onR = (r: unknown) => captured.push(r);
  process.on("unhandledRejection", onR);
  process.env.STACKS_STUB_SLEEP = "0.4";
  let resolved = "pending";
  const p = runWorkflow({ snippetId: "mid", script: `export const meta = { name: "n", description: "d" };\nawait agent("go");\nlog("after-delete");` }).then(() => { resolved = "resolved"; }, (e) => { resolved = "rejected:" + (e as Error).message; });
  setTimeout(() => { try { db.delete(feedSnippets).where(eq(feedSnippets.id, "mid")).run(); } catch (e) { console.log("delete failed", (e as Error).message); } }, 150);
  await p;
  await new Promise((r) => setTimeout(r, 400));
  process.off("unhandledRejection", onR);
  delete process.env.STACKS_STUB_SLEEP;
  console.log("resolved:", resolved, "unhandled:", captured.length, captured.map((c) => (c as Error).message));
});

test("runWorkflow against a snippet that does not exist", async () => {
  let outcome = "resolved";
  await runWorkflow({ snippetId: "ghost", script: `export const meta = { name: "n", description: "d" };\nlog("x");` }).catch((e) => { outcome = "rejected:" + (e as Error).message; });
  console.log("ghost:", outcome);
});

test("log() size: unbounded content into feed_messages", async () => {
  seed("bigmsg");
  await runWorkflow({ snippetId: "bigmsg", script: `export const meta = { name: "n", description: "d" };\nlog("Z".repeat(3000000));\nphase("P".repeat(1000));` });
  await new Promise((r) => setTimeout(r, 300));
  const m = msgs("bigmsg");
  console.log("lens", m.map((s) => s.length), "status", row("bigmsg")?.status);
});

test("log(non-string) coercion + throwing toString", async () => {
  seed("coerce");
  await runWorkflow({ snippetId: "coerce", script: `export const meta = { name: "n", description: "d" };\nlog({ a: 1 });\nlog(null);\nlog(undefined);\ntry { log({ toString() { throw new Error("boom"); } }); } catch (e) { }\nlog("end");` });
  await new Promise((r) => setTimeout(r, 300));
  console.log("coerce msgs", JSON.stringify(msgs("coerce")), "status", row("coerce")?.status, "err", row("coerce")?.error);
});
