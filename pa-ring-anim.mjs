import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.env.FRAMES;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

// A simulated sync: ten resumable passes of 20 writes each, then a final pass that
// finishes. Exactly the shape the real route answers with.
const TOTAL_PASSES = 10;
let pass = 0;
await page.route("**/api/feed/github/sync", async (route) => {
  pass += 1;
  const done = pass * 20;
  const remaining = Math.max(0, (TOTAL_PASSES - pass) * 20);
  const last = pass >= TOTAL_PASSES;
  await new Promise((resolve) => setTimeout(resolve, pass === 1 ? 900 : 260));
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(last
      ? { ok: true, counts: { commentsPosted: 47, issuesCreated: 3, commentsIngested: 5 }, pending: false, mutations: 20, remaining }
      : { ok: true, counts: { commentsPosted: 4 }, pending: true, pauseReason: "batch", retryAfterMs: 150, mutations: 20, remaining }),
  });
});

await page.goto("http://127.0.0.1:3000/feed", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const card = page.locator(".sync-card");
if (!(await card.count())) { console.log("no sync card"); await browser.close(); process.exit(1); }

let frame = 0;
const shoot = async () => {
  await card.screenshot({ path: `${OUT}/${String(frame).padStart(3, "0")}.png` });
  frame += 1;
};
await shoot();
await page.locator(".sync-card button").first().click();
const started = Date.now();
while (Date.now() - started < 7000) {
  await shoot();
  await page.waitForTimeout(60);
}
console.log("frames:", frame, "| passes served:", pass);
await browser.close();
