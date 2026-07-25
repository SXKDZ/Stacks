import { chromium } from "playwright";
const tag = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
for (const [name, tab] of [["library","Library"],["collections","Collections"],["venues","Venues"],["authors","Authors"],["discover","Discover"],["settings","Settings"],["home","Overview"]]) {
  await p.goto("http://127.0.0.1:3000/", { waitUntil: "networkidle" });
  await p.locator("button", { hasText: new RegExp("^"+tab) }).first().click().catch(()=>{});
  await p.waitForTimeout(1400);
  await p.screenshot({ path: `__${tag}-${name}.png`, fullPage: true });
}
await b.close();
