import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const libDir = mkdtempSync(join(tmpdir(), "wfrev7-"));
process.env.STACKS_LIBRARY_DIR = libDir;
const stub = join(libDir, "fake-claude.sh");
writeFileSync(stub, `#!/bin/sh\nsleep \${STACKS_STUB_SLEEP:-0}\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"OK"}'\n`);
chmodSync(stub, 0o755);
process.env.STACKS_CLAUDE_BIN = stub;

const { readWorkflowMeta, runWorkflow } = await import("../../app/lib/workflow-runtime.ts");
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

test("BOM / CRLF / shebang imported .js file", () => {
  const base = `export const meta = { name: "Imported", description: "d" };\nlog("hi");\n`;
  console.log("plain:", JSON.stringify(readWorkflowMeta(base)));
  console.log("BOM:", JSON.stringify(readWorkflowMeta("﻿" + base)));
  console.log("CRLF:", JSON.stringify(readWorkflowMeta(base.replace(/\n/g, "\r\n"))));
  console.log("shebang:", JSON.stringify(readWorkflowMeta("#!/usr/bin/env node\n" + base)));
  console.log("export at col>0:", JSON.stringify(readWorkflowMeta("  " + base)));
});

test("truncation of a VALID long script breaks the stored copy", async () => {
  const head = `export const meta = { name: "Trunc", description: "d" };\n`;
  const line = `log("padding line");\n`;
  const script = head + line.repeat(Math.ceil((200_050 - head.length) / line.length));
  console.log("input len", script.length, "meta ok?", JSON.stringify(readWorkflowMeta(script)));
  const b = await (await wfRoute.POST(post({ workflows: [{ id: "tr", script }] }))).json();
  const stored = b.workflows[0].script;
  console.log("stored len", stored.length, "name", b.workflows[0].name, "tail", JSON.stringify(stored.slice(-25)));
  console.log("stored meta:", JSON.stringify(readWorkflowMeta(stored)));
  const res = await runRoute.POST(post({ script: stored }, "http://127.0.0.1/api/feed/workflows/run"));
  console.log("run stored ->", res.status, JSON.stringify(await res.json()).slice(0, 140));
});

test("missing claude binary -> workflow ends error, not hang", async () => {
  seed("nobin");
  const saved = process.env.STACKS_CLAUDE_BIN;
  process.env.STACKS_CLAUDE_BIN = join(libDir, "does-not-exist-claude");
  await runWorkflow({ snippetId: "nobin", script: `export const meta = { name: "n", description: "d" };\nawait agent("go");\nlog("never");` });
  await new Promise((r) => setTimeout(r, 400));
  process.env.STACKS_CLAUDE_BIN = saved;
  console.log("status", row("nobin")?.status, "err", row("nobin")?.error, "msgs", JSON.stringify(msgs("nobin")));
});

test("child-process harness works for unhandled rejections", () => {
  const driver = join(libDir, "driver-dyn.ts");
  writeFileSync(driver, `
process.env.STACKS_LIBRARY_DIR = ${JSON.stringify(libDir)};
const { readWorkflowMeta } = await import(${JSON.stringify(join(process.cwd(), "app/lib/workflow-runtime.ts"))});
const meta = readWorkflowMeta('export const meta = { name: "n", description: "d" };\\nimport("node:fs");');
console.log("META " + JSON.stringify(meta));
await new Promise((r) => setTimeout(r, 200));
console.log("SURVIVED");
`);
  const r = spawnSync(process.execPath, ["--import", "tsx", driver], { encoding: "utf8", cwd: process.cwd() });
  console.log("exit", r.status, "signal", r.signal);
  console.log("stdout", JSON.stringify(r.stdout));
  console.log("stderr tail", JSON.stringify((r.stderr || "").slice(0, 260)));
});
