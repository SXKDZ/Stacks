import assert from "node:assert/strict";
import test from "node:test";

import { jsonRequest, readJson } from "../support/harness.ts";

test("a direct PDF URL bypasses webpage rendering and is returned for acquisition", async () => {
  const { POST } = await import("../../app/api/import/route.ts");
  const url = "https://sxkdz.github.io/files/publications/COLM/RetroAgent/RetroAgent.pdf";

  const result = await readJson(await POST(jsonRequest("http://127.0.0.1/api/import", { url })));

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    source: "PDF URL",
    title: "RetroAgent",
    abstract: "",
    url,
    pdfUrl: url,
    preprintId: null,
    readerContent: "",
  });
});
