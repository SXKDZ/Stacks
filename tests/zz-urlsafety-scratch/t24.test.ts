import test, { mock } from "node:test";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const ROOT = "/Users/SXKDZ/Documents/Coding/Repository/PaperAssistant";
const { createTempLibrary, jsonRequest, readJson } = await import(`${ROOT}/tests/support/harness.ts`);
const dir = createTempLibrary("probe24");
const fake = { html: "", title: "", status: 200, finalUrl: "https://example.com/f", navs: [] as string[] };
mock.module("playwright", {
  namedExports: {
    webkit: {
      launch: async () => ({
        isConnected: () => true,
        newContext: async () => ({
          newPage: async () => ({
            goto: async (h: string) => { fake.navs.push(h); return { status: () => fake.status, statusText: () => "Err" }; },
            evaluate: async () => undefined,
            waitForTimeout: async () => undefined,
            content: async () => fake.html,
            title: async () => fake.title,
            url: () => fake.finalUrl,
            mainFrame: () => ({}),
          }),
          close: async () => undefined,
        }),
      }),
    },
  },
});
const { POST } = await import(`${ROOT}/app/api/source-acquisition/route.ts`);
const { POST: importPost } = await import(`${ROOT}/app/api/import/route.ts`);
function lsHtml() { return existsSync(join(dir, "html_snapshots")) ? readdirSync(join(dir, "html_snapshots")) : []; }
function clearHtml() { for (const f of lsHtml()) unlinkSync(join(dir, "html_snapshots", f)); }
test("late marker", async () => {
  fake.title = "";
  fake.html = `<html><body><div>${"y".repeat(4200)}</div><h1>Verifying your browser before accessing</h1></body></html>`;
  console.log("late acquire:", JSON.stringify(await readJson(await POST(jsonRequest("http://127.0.0.1/api/source-acquisition", { operation: "acquire", preferred: "html", sourceUrl: "https://example.com/chal", title: "Late" })))), lsHtml());
  clearHtml();
  const imp = await readJson(await importPost(jsonRequest("http://127.0.0.1/api/import", { url: "https://example.com/chal" })));
  console.log("late import:", imp.status, JSON.stringify(imp.body).slice(0, 200));
  fake.html = "<html><body><h1>Verifying your browser before accessing</h1></body></html>";
  console.log("early:", JSON.stringify(await readJson(await POST(jsonRequest("http://127.0.0.1/api/source-acquisition", { operation: "acquire", preferred: "html", sourceUrl: "https://example.com/chal2", title: "Early" })))), lsHtml());
  clearHtml();
});
