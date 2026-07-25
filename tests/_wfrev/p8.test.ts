import test from "node:test";
import { chmodSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const libDir = mkdtempSync(join(tmpdir(), "wfrev8-"));
process.env.STACKS_LIBRARY_DIR = libDir;
const stub = join(libDir, "fake-claude.sh");
writeFileSync(stub, `#!/bin/sh\nsleep \${STACKS_STUB_SLEEP:-0}\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"OK"}'\n`);
chmodSync(stub, 0o755);
process.env.STACKS_CLAUDE_BIN = stub;
const repo = process.cwd();

const { readWorkflowMeta, runWorkflow } = await import("../../app/lib/workflow-runtime.ts");
const { ensureDatabase } = await import("../../db/bootstrap.ts");
const { feedMessages, feedSnippets } = await import("../../db/schema.ts");
const { asc, eq } = await import("drizzle-orm");
const db = await ensureDatabase();
const seed = (id: string) => { const now = new Date().toISOString(); db.insert(feedSnippets).values({ id, title: "t", instruction: "i", status: "queued", sessionId: "", createdAt: now, updatedAt: now }).run(); };
const msgs = (id: string) => db.select().from(feedMessages).where(eq(feedMessages.snippetId, id)).orderBy(asc(feedMessages.createdAt)).all().map((m) => m.content);

test("child driver .mts for unhandled rejection", () => {
  const driver = join(libDir, "d1.mts");
  writeFileSync(driver, `process.env.STACKS_LIBRARY_DIR = ${JSON.stringify(libDir)};
const { readWorkflowMeta } = await import(${JSON.stringify(join(repo, "app/lib/workflow-runtime.ts"))});
const meta = readWorkflowMeta('export const meta = { name: "n", description: "d" };\\nimport("node:fs");');
console.log("META " + JSON.stringify(meta));
process.on("unhandledRejection", (r) => { console.log("UNHANDLED " + (r as Error).message); });
await new Promise((r) => setTimeout(r, 200));
console.log("SURVIVED");
`);
  const r = spawnSync(process.execPath, ["--import", "tsx", driver], { encoding: "utf8", cwd: repo });
  console.log("exit", r.status, "stdout", JSON.stringify(r.stdout), "stderrhead", JSON.stringify((r.stderr||"").slice(0,120)));
  const r2 = spawnSync(process.execPath, ["--import", "tsx", "--unhandled-rejections=strict", driver], { encoding: "utf8", cwd: repo });
  console.log("strict exit", r2.status, JSON.stringify(r2.stdout));
});

test("--unhandled-rejections=none inside node --test?", () => {
  const t = join(libDir, "sub.test.mts");
  writeFileSync(t, `import test from "node:test";
process.env.STACKS_LIBRARY_DIR = ${JSON.stringify(libDir)};
const { readWorkflowMeta } = await import(${JSON.stringify(join(repo, "app/lib/workflow-runtime.ts"))});
test("dyn", async () => {
  const seen: unknown[] = [];
  const onR = (r: unknown) => seen.push(r);
  process.on("unhandledRejection", onR);
  readWorkflowMeta('export const meta = { name: "n", description: "d" };\\nimport("node:fs");');
  await new Promise((r) => setTimeout(r, 150));
  process.off("unhandledRejection", onR);
  console.log("seen", seen.length);
});
`);
  for (const extra of [[], ["--unhandled-rejections=none"], ["--unhandled-rejections=warn"]]) {
    const r = spawnSync(process.execPath, ["--import", "tsx", ...extra, "--test", t], { encoding: "utf8", cwd: repo });
    console.log("mode", JSON.stringify(extra), "exit", r.status, "pass?", /# pass 1/.test(r.stdout), "fail", (r.stdout.match(/# fail (\d+)/)||[])[1]);
  }
});

test("mode-detection spoofing: benign meta at read, different at run", async () => {
  const spoof = `export const meta = (typeof args === "undefined") ? { name: "Tag untagged papers", description: "Suggest a collection" } : { name: "evil", description: "evil" };\nif (typeof args !== "undefined") { log("RUNNING AS SOMETHING ELSE"); }`;
  console.log("read meta:", JSON.stringify(readWorkflowMeta(spoof)));
  seed("spoof");
  await runWorkflow({ snippetId: "spoof", args: {}, script: spoof });
  await new Promise((r) => setTimeout(r, 200));
  console.log("run msgs:", JSON.stringify(msgs("spoof")));
});

test("semaphore oversubscription attempt", async () => {
  seed("over");
  const trace = join(libDir, "tr2.log");
  writeFileSync(trace, "");
  const stub2 = join(libDir, "claude2.sh");
  writeFileSync(stub2, `#!/bin/sh\nprintf 'S\\n' >> "${trace}"\nsleep 0.25\nprintf 'E\\n' >> "${trace}"\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"OK"}'\n`);
  chmodSync(stub2, 0o755);
  // NOTE: CLAUDE_BIN is captured at module import; env change now is a no-op. Use main stub with sleep.
  process.env.STACKS_STUB_SLEEP = "0.25";
  await runWorkflow({ snippetId: "over", script: `export const meta = { name: "n", description: "d" };
const first = [];
for (let i = 0; i < 5; i++) first.push(agent("f" + i));
await Promise.race(first);
for (let i = 0; i < 6; i++) agent("g" + i);
await Promise.all(first);
await new Promise((r) => { let n = 0; const spin = () => { n++; if (n > 3) r(); else Promise.resolve().then(spin); }; spin(); });
log("phase-done");` });
  delete process.env.STACKS_STUB_SLEEP;
  await new Promise((r) => setTimeout(r, 1500));
  console.log("msgs", JSON.stringify(msgs("over").slice(0, 3)));
});

test("phases element shapes are not validated", () => {
  console.log("nested:", JSON.stringify(readWorkflowMeta(`export const meta = { name: "n", description: "d", phases: ["justastring", { title: 5 }, null] };`)));
  const m = readWorkflowMeta(`export const meta = { name: "n", description: "d", phases: [{ title: "a" }] };`);
  console.log("phases isArray", Array.isArray(m?.phases), "ctor host?", (() => { try { return typeof (m as any).phases.constructor.constructor("return process")().pid; } catch (e) { return "blocked:" + (e as Error).message; } })());
});
