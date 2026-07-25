import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libDir = mkdtempSync(join(tmpdir(), "wfrev4-"));
process.env.STACKS_LIBRARY_DIR = libDir;
const stub = join(libDir, "fake-claude.sh");
writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"OK"}'\n`);
chmodSync(stub, 0o755);
process.env.STACKS_CLAUDE_BIN = stub;

const wfRoute = await import("../../app/api/feed/workflows/route.ts");
const runRoute = await import("../../app/api/feed/workflows/run/route.ts");
const localSettings = await import("../../app/lib/local-settings.ts");
const post = (body: unknown, url = "http://127.0.0.1/api/feed/workflows") => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("script cap truncates code silently -> stored script unrunnable", async () => {
  const head = `export const meta = { name: "Trunc", description: "d" };\n`;
  const filler = `log("${"a".repeat(199_000)}");\n`;
  const tail = `log("tail-that-gets-cut");\n`;
  const script = head + filler + "x".repeat(200_001 - head.length - filler.length - tail.length) + tail;
  console.log("input len", script.length);
  const b = await (await wfRoute.POST(post({ workflows: [{ id: "t", script }] }))).json();
  const stored = b.workflows[0].script;
  console.log("stored len", stored.length, "name", b.workflows[0].name, "equal?", stored === script);
  const res = await runRoute.POST(post({ script: stored }, "http://127.0.0.1/api/feed/workflows/run"));
  console.log("run stored script ->", res.status, JSON.stringify(await res.json()).slice(0, 160));
});

test("one malformed feedWorkflows entry in settings.json nukes every other setting", async () => {
  // Write a fully-populated settings.json by hand, including a secret.
  mkdirSync(libDir, { recursive: true });
  const file = join(libDir, "settings.json");
  const good = {
    version: 1, updatedAt: new Date().toISOString(), libraryName: "MyLib",
    ai: { modelId: "us.anthropic.claude-sonnet-4-6", region: "us-east-1", maxTokens: "10000", temperature: "0.25" },
    prompts: { extractionSystem: "EXTRACT", summarySystem: "SUMMARY" },
    sync: { remotePath: "/tmp/remote", autoSync: "false", autoSyncInterval: "5" },
    github: { repo: "me/repo" },
    feedWorkflows: [{ id: "x", name: "n", script: "export const meta = { name: 'n', description: 'd' };" }], // description MISSING
    secrets: { AWS_BEARER_TOKEN_BEDROCK: "SECRET-TOKEN", SEMANTIC_SCHOLAR_API_KEY: "", SERPAPI_KEY: "", GITHUB_TOKEN: "GH-TOKEN" },
  };
  writeFileSync(file, JSON.stringify(good, null, 2));
  console.log("GET workflows:", JSON.stringify(await (await wfRoute.GET()).json()));
  console.log("runtimeValues:", JSON.stringify(localSettings.runtimeValues()));
  // Now the user saves a workflow through the UI.
  await wfRoute.POST(post({ workflows: [{ id: "n1", script: `export const meta = { name: "New", description: "d" };` }] }));
  const after = JSON.parse(readFileSync(file, "utf8"));
  console.log("after save: secrets", JSON.stringify(after.secrets), "libraryName", after.libraryName, "prompts.extract", String(after.prompts.extractionSystem).slice(0, 12), "github", JSON.stringify(after.github), "sync", JSON.stringify(after.sync));
});
