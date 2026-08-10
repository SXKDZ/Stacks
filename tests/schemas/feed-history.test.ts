import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyFeedHistoryAttachments } from "../../app/lib/feed-history-attachments";
import {
  buildFeedTranscript,
  groupFeedInteractions,
  OPENING_INTERACTION_ID,
  selectFeedHistory,
  type FeedHistoryMessage,
} from "../../app/lib/feed-history";
import { feedMarkdown } from "../../app/lib/feed-export";

function message(
  id: string,
  role: "user" | "assistant" | "system" | "tool",
  kind: string,
  content: string,
  extras: Partial<FeedHistoryMessage> = {},
): FeedHistoryMessage {
  return { id, role, kind, content, createdAt: `2026-08-09T00:00:0${id.length}.000Z`, ...extras };
}

const history: FeedHistoryMessage[] = [
  message("a1", "assistant", "text", "Opening answer"),
  message("u2", "user", "text", "Second question", { attachments: '[{"kind":"upload","label":"notes.txt","relativePath":"attachments/notes.txt"}]' }),
  message("t2", "assistant", "tool_use", "Read file", { toolUseId: "tool-2" }),
  message("r2", "tool", "tool_result", "file contents", { toolUseId: "tool-2" }),
  message("a2", "assistant", "result", "Second answer"),
  message("u3", "user", "text", "Third question"),
  message("a3", "assistant", "result", "Third answer"),
];

test("groups feed history at user-turn boundaries", () => {
  const groups = groupFeedInteractions("Opening question", null, history);
  assert.deepEqual(groups.map((group) => group.id), [OPENING_INTERACTION_ID, "u2", "u3"]);
  assert.deepEqual(groups.map((group) => group.messages.map((item) => item.id)), [
    ["a1"],
    ["u2", "t2", "r2", "a2"],
    ["u3", "a3"],
  ]);
});

test("selected interactions retain chronology and use the first user turn as the new opening", () => {
  const selected = selectFeedHistory({
    instruction: "Opening question",
    messages: history,
    interactionIds: ["u3", "u2"],
    includeToolDetails: false,
  });

  // Request order cannot reorder history: the authoritative chronology wins.
  assert.deepEqual(selected.selectedIds, ["u2", "u3"]);
  assert.equal(selected.instruction, "Second question");
  assert.match(selected.openingAttachments ?? "", /notes\.txt/);
  assert.deepEqual(selected.messages.map((item) => item.id), ["a2", "u3", "a3"]);
});

test("tool details are copied only when requested, without splitting the pair", () => {
  const clean = selectFeedHistory({
    instruction: "Opening question",
    messages: history,
    interactionIds: ["u2"],
    includeToolDetails: false,
  });
  const detailed = selectFeedHistory({
    instruction: "Opening question",
    messages: history,
    interactionIds: ["u2"],
    includeToolDetails: true,
  });

  assert.deepEqual(clean.messages.map((item) => item.id), ["a2"]);
  assert.deepEqual(detailed.messages.map((item) => item.id), ["t2", "r2", "a2"]);
});

test("unknown interaction ids are rejected", () => {
  assert.throws(
    () => selectFeedHistory({
      instruction: "Opening question",
      messages: history,
      interactionIds: ["missing"],
      includeToolDetails: false,
    }),
    /Unknown interaction: missing/,
  );
});

test("fresh-session transcript includes the opening and excludes tool noise", () => {
  assert.equal(
    buildFeedTranscript("Opening question", history),
    [
      "User: Opening question",
      "Assistant: Opening answer",
      "User: Second question",
      "Assistant: Second answer",
      "User: Third question",
      "Assistant: Third answer",
    ].join("\n\n"),
  );
});

test("fresh-session transcript includes paired tool details when the feed requests them", () => {
  const transcript = buildFeedTranscript("Opening question", history, true);
  assert.match(transcript, /Assistant tool request: Read file/);
  assert.match(transcript, /Tool result: file contents/);
  assert.ok(transcript.indexOf("Assistant tool request") < transcript.indexOf("Tool result"));
});

test("Markdown export starts with the full opening request and preserves every event", () => {
  const markdown = feedMarkdown({
    title: "Selected history",
    instruction: "Opening request\n\nRead both papers.",
    messages: [
      message("a1", "assistant", "text", "Opening answer"),
      message("u2", "user", "text", "Follow-up request"),
      message("t2", "assistant", "tool_use", "Bash {\"command\":\"echo `ok`\"}"),
      message("r2", "tool", "tool_result", "`ok`", { toolUseId: "tool-2" }),
      message("e2", "system", "error", "Turn failed"),
    ],
  });

  assert.ok(markdown.indexOf("**You:** Opening request") < markdown.indexOf("**Agent:** Opening answer"));
  assert.match(markdown, /Opening request\n\nRead both papers\./);
  assert.match(markdown, /\*\*You:\*\* Follow-up request/);
  assert.match(markdown, /\*\*Agent tool request:\*\*/);
  assert.match(markdown, /\*\*Tool result:\*\*/);
  assert.match(markdown, /\*\*Error:\*\* Turn failed/);
});

test("history attachment cloning copies staged uploads but keeps papers as references", () => {
  const root = mkdtempSync(join(tmpdir(), "stacks-feed-history-"));
  const source = join(root, "source");
  const target = join(root, "target");
  mkdirSync(join(source, "attachments"), { recursive: true });
  writeFileSync(join(source, "attachments", "notes.txt"), "selected context");
  try {
    const copied = copyFeedHistoryAttachments(source, target, JSON.stringify([
      { kind: "upload", label: "notes.txt", relativePath: "attachments/notes.txt" },
      { kind: "paper", label: "A paper", paperId: "paper-1" },
      { kind: "upload", label: "unsafe", relativePath: "../outside.txt" },
    ]));
    assert.deepEqual(copied.map((attachment) => attachment.label), ["notes.txt", "A paper"]);
    assert.equal(readFileSync(join(target, "attachments", "notes.txt"), "utf8"), "selected context");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
