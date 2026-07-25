import test, { mock } from "node:test";
// Static import of webpage-snapshot loads REAL playwright before mock.module.
import { looksBlocked, htmlToText } from "../../app/lib/webpage-snapshot.ts";
import { jsonRequest, readJson } from "../support/harness.ts";

mock.module("playwright", { namedExports: { webkit: { launch: async () => { throw new Error("SENTINEL"); } } } });

const { POST } = await import("../../app/api/import/route.ts");

test("does a static webpage-snapshot import defeat the playwright mock?", { timeout: 20_000 }, async () => {
  console.log("pure helpers work:", looksBlocked("<p>x</p>", "Just a moment"), JSON.stringify(htmlToText("<p>hi</p>")));
  const r = await readJson(await POST(jsonRequest("http://127.0.0.1/api/import", { url: "https://example.com/a" })));
  console.log("result", r.status, JSON.stringify(r.body).slice(0, 200));
});
