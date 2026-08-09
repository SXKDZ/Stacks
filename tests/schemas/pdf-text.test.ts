import assert from "node:assert/strict";
import test from "node:test";

import { readPdfPagesFromDocument } from "../../app/lib/pdf-text.ts";

test("PDF page extraction returns all selected text without a character cap", async () => {
  const pageText = "x".repeat(20_000);
  const document = {
    numPages: 2,
    async getPage() {
      return {
        async getTextContent() {
          return { items: [{ str: pageText }] };
        },
        cleanup() {},
      };
    },
  };

  const result = await readPdfPagesFromDocument(document as never, { start: 1, end: null });

  assert.equal(result.text, `${pageText}\n\n${pageText}`);
  assert.ok(result.text.length > 32_000);
});
