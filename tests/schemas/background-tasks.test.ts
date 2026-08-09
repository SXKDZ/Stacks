import assert from "node:assert/strict";
import test from "node:test";

import { cleanTaskText } from "../../app/components/BackgroundTasks.tsx";

test("activity errors remove terminal formatting without truncating the message", () => {
  const detail = "page.goto: Download is starting\nCall log:\n\u001b[2m  - navigating to the complete PDF URL\u001b[22m";
  assert.equal(
    cleanTaskText(detail),
    "page.goto: Download is starting\nCall log:\n  - navigating to the complete PDF URL",
  );
});
