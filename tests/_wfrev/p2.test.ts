import test from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libDir = mkdtempSync(join(tmpdir(), "wfrev2-"));
process.env.STACKS_LIBRARY_DIR = libDir;
const stub = join(libDir, "fake-claude.sh");
writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"OK"}'\n`);
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
const post = (body: unknown, url = "http://127.0.0.1/api/feed/workflows") => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("save route: RCE at save time + cross-origin text/plain", async () => {
  const target = join(libDir, "save-time-pwned.txt");
  const script = `export const meta = { name: "innocent", description: "looks fine" };\nlog.constructor.constructor("return process")().getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(target)}, "owned-at-save");`;
  const res = await wfRoute.POST(new Request("http://127.0.0.1/api/feed/workflows", { method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ workflows: [{ id: "rce", script }] }) }));
  console.log("status", res.status, "wrote", existsSync(target), existsSync(target) ? readFileSync(target, "utf8") : "");
  console.log("body", JSON.stringify(await res.json()).slice(0, 300));
});

test("save route: getter flip throws?", async () => {
  const FLIP = `let n = 0;\nexport const meta = { get name() { n++; return n === 1 ? "str" : { evil: 1 }; }, description: "d" };`;
  try {
    const res = await wfRoute.POST(post({ workflows: [{ id: "flip", script: FLIP }, { id: "good", script: `export const meta = { name: "Good", description: "g" };` }] }));
    console.log("flip status", res.status, JSON.stringify(await res.json()).slice(0, 300));
  } catch (e) { console.log("flip THREW", (e as Error).constructor.name, (e as Error).message); }
  const listed = await (await wfRoute.GET()).json();
  console.log("after flip GET", JSON.stringify(listed).slice(0, 300));
});

test("save route: caps + normalize precedence", async () => {
  const mk = (n: number, d: number) => `export const meta = { name: ${JSON.stringify("N".repeat(n))}, description: ${JSON.stringify("D".repeat(d))} };`;
  for (const [n, d] of [[80, 300], [81, 301]]) {
    const b = await (await wfRoute.POST(post({ workflows: [{ id: "cap", script: mk(n, d) }] }))).json();
    console.log("cap", n, d, "->", b.workflows[0].name.length, b.workflows[0].description.length);
  }
  const head = `export const meta = { name: "n", description: "d" };\n`;
  for (const total of [200000, 200001]) {
    const b = await (await wfRoute.POST(post({ workflows: [{ id: "cap2", script: head + "/".repeat(total - head.length) }] }))).json();
    console.log("scriptcap", total, "->", b.workflows[0].script.length);
  }
  const persisted = JSON.parse(readFileSync(join(libDir, "settings.json"), "utf8"));
  console.log("persisted lens", persisted.feedWorkflows.map((w: any) => [w.name.length, w.description.length, w.script.length]));
  const b2 = await (await wfRoute.POST(post({ workflows: [
    { id: "a", name: "POSTED", description: "POSTEDD", script: `export const meta = { name: "FromMeta", description: "FromMetaD" };` },
    { id: "b", name: "posted-only", description: "pd", script: `log(1);` },
    { id: "c", script: `log(1);` },
    { id: "d", name: "drop-me", script: "   " },
    "not-an-object",
    { id: 12345, script: `export const meta = { name: "numid", description: "d" };` },
    { script: `export const meta = { name: "AutoId", description: "d" };` },
  ] }))).json();
  console.log("normalize", JSON.stringify(b2.workflows.map((w: any) => [w.id, w.name, w.description])));
  const b3 = await (await wfRoute.POST(post({ workflows: [{ id: "e", name: "posted", script: `export const meta = { name: "", description: "" };` }] }))).json();
  console.log("empty meta", JSON.stringify(b3.workflows));
});

test("save route: malformed body wipes", async () => {
  await wfRoute.POST(post({ workflows: [{ id: "keep", script: `export const meta = { name: "Keep", description: "d" };` }] }));
  console.log("before", JSON.stringify(await (await wfRoute.GET()).json()).slice(0, 200));
  for (const body of [JSON.stringify({}), JSON.stringify({ workflows: "nope" }), "not json"]) {
    const r = await wfRoute.POST(new Request("http://127.0.0.1/api/feed/workflows", { method: "POST", body }));
    const listed = await (await wfRoute.GET()).json();
    console.log("hostile", JSON.stringify(body).slice(0, 30), "status", r.status, "listed", JSON.stringify(listed));
    await wfRoute.POST(post({ workflows: [{ id: "keep", script: `export const meta = { name: "Keep", description: "d" };` }] }));
  }
});

test("save route: DoS timing", async () => {
  const hostile = `export const meta = { name: "h", description: "d" };\nwhile (true) {}`;
  const t0 = Date.now();
  const res = await wfRoute.POST(post({ workflows: [1, 2, 3].map((i) => ({ id: `dos-${i}`, script: hostile })) }));
  console.log("3 hostile elapsed", Date.now() - t0, "status", res.status, JSON.stringify(await res.json()).slice(0, 120));
});

test("run route: 400 shapes + happy path + description cap", async () => {
  for (const body of [{}, { script: "   " }, { script: null }, { script: 123 }, { script: `log("x");` }]) {
    const res = await runRoute.POST(post(body, "http://127.0.0.1/api/feed/workflows/run"));
    console.log("run 400?", JSON.stringify(body).slice(0, 30), res.status, JSON.stringify(await res.json()));
  }
  const res = await runRoute.POST(post({ script: `export const meta = { name: "Nightly", description: "instr" };\nlog("ran");` }, "http://127.0.0.1/api/feed/workflows/run"));
  console.log("happy", res.status);
  const { id } = await res.json();
  console.log("id", id, "dir", existsSync(join(libDir, "feed", id)));
  await new Promise((r) => setTimeout(r, 500));
  const row = db.select().from(feedSnippets).where(eq(feedSnippets.id, id)).get();
  console.log("row", row?.title, "|", row?.instruction, "|", row?.status, "msgs", JSON.stringify(msgs(id)));
  const big = await runRoute.POST(post({ script: `export const meta = { name: "T".repeat(200), description: "D".repeat(500000) };` }, "http://127.0.0.1/api/feed/workflows/run"));
  const bid = (await big.json()).id;
  await new Promise((r) => setTimeout(r, 300));
  const brow = db.select().from(feedSnippets).where(eq(feedSnippets.id, bid)).get();
  console.log("instr len", brow?.instruction.length, "title len", brow?.title.length, "title", brow?.title.slice(0, 20));
});
