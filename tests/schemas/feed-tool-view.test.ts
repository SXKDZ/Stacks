/**
 * How a stored tool call reads in a thread. The inputs here are the real shapes the
 * Claude CLI emits (captured from a headless run), because the value of this module
 * is entirely in matching them.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  backgroundShellId,
  describeToolCall,
  diffLines,
  parseTaskReport,
  parseToolInvocation,
  shortPath,
  workflowMeta,
} from "../../app/lib/feed-tool-view.ts";

const describe = (content: string) => describeToolCall(parseToolInvocation(content));

test("a stored row splits back into the tool's name and its input", () => {
  const invocation = parseToolInvocation('Bash {"command":"ls -la","description":"List files"}');
  assert.equal(invocation.name, "Bash");
  assert.deepEqual(invocation.input, { command: "ls -la", description: "List files" });
  assert.equal(invocation.raw, '{"command":"ls -la","description":"List files"}');

  // A row from a version that stored something else still names its tool, and the
  // card falls back to the raw text rather than rendering nothing.
  const malformed = parseToolInvocation("Bash not json at all");
  assert.equal(malformed.name, "Bash");
  assert.equal(malformed.input, null);
  assert.equal(malformed.raw, "not json at all");
  assert.equal(parseToolInvocation("").name, "tool");
});

test("a line diff aligns what stayed against what changed", () => {
  const lines = diffLines("one\ntwo\nthree", "one\ntwo and a half\nthree");
  assert.deepEqual(lines, [
    { type: "context", text: "one" },
    { type: "remove", text: "two" },
    { type: "add", text: "two and a half" },
    { type: "context", text: "three" },
  ]);

  // Pure insertion keeps the surrounding lines as context, so the card shows where
  // the new lines went rather than replacing the whole block.
  assert.deepEqual(diffLines("a\nb", "a\nnew\nb"), [
    { type: "context", text: "a" },
    { type: "add", text: "new" },
    { type: "context", text: "b" },
  ]);
  assert.deepEqual(diffLines("", "only"), [{ type: "add", text: "only" }]);
  assert.deepEqual(diffLines("gone", ""), [{ type: "remove", text: "gone" }]);

  // Past the alignment ceiling the two sides are shown whole instead: a quadratic
  // walk over a huge edit would block the thread from rendering at all.
  const huge = Array.from({ length: 700 }, (_, index) => `line ${index}`).join("\n");
  const other = Array.from({ length: 700 }, (_, index) => `other ${index}`).join("\n");
  const fallback = diffLines(huge, other);
  assert.equal(fallback.length, 1400);
  assert.equal(fallback[0].type, "remove");
  assert.equal(fallback.at(-1)?.type, "add");
});

test("an edit reads as a diff of the lines it replaced", () => {
  const view = describe('Edit {"file_path":"/repo/app/lib/feed-agent.ts","old_string":"const a = 1;","new_string":"const a = 1;\\nconst b = 2;"}');
  assert.equal(view.kind, "diff");
  if (view.kind !== "diff") return;
  assert.deepEqual(view.heading, { name: "Edit", subject: "lib/feed-agent.ts", stat: "+1 −0" });
  assert.equal(view.diff.path, "/repo/app/lib/feed-agent.ts");
  assert.deepEqual(view.diff.lines.map((line) => line.type), ["context", "add"]);
  assert.equal(view.diff.whole, false);
});

test("a written file is all additions, and a multi-edit shows every pair", () => {
  const write = describe('Write {"file_path":"notes.md","content":"alpha\\nbeta"}');
  assert.equal(write.kind, "diff");
  if (write.kind !== "diff") return;
  assert.deepEqual(write.heading, { name: "Write", subject: "notes.md", stat: "+2 −0" });
  assert.ok(write.diff.whole);
  assert.deepEqual(write.diff.lines.map((line) => line.text), ["alpha", "beta"]);

  const multi = describe('MultiEdit {"file_path":"a/b/c.ts","edits":[{"old_string":"one","new_string":"1"},{"old_string":"two","new_string":"2"}]}');
  assert.equal(multi.kind, "diff");
  if (multi.kind !== "diff") return;
  assert.deepEqual(multi.heading, { name: "Edit", subject: "b/c.ts", stat: "+2 −2" });
});

test("a spawned agent reads as its own run", () => {
  const view = describe('Agent {"subagent_type":"Explore","description":"Find the callers","prompt":"Search the repo for callers of runFeedAgent.","run_in_background":false}');
  assert.equal(view.kind, "subagent");
  if (view.kind !== "subagent") return;
  assert.deepEqual(view.heading, { name: "Explore subagent", subject: "Find the callers" });
  assert.equal(view.prompt, "Search the repo for callers of runFeedAgent.");
  assert.equal(view.background, false);
  // The tool is named Task in some CLI versions and Agent in others.
  assert.equal(describe('Task {"subagent_type":"general-purpose","description":"x","prompt":"y"}').kind, "subagent");
});

test("a shell names its command, and a backgrounded one says so", () => {
  const foreground = describe('Bash {"command":"npm test","description":"Run the suite"}');
  assert.equal(foreground.kind, "shell");
  if (foreground.kind !== "shell") return;
  assert.deepEqual(foreground.heading, { name: "Shell", subject: "npm test" });
  assert.equal(foreground.background, false);

  const background = describe('Bash {"command":"sleep 2; echo finished","run_in_background":true}');
  assert.equal(background.kind, "shell");
  if (background.kind !== "shell") return;
  assert.equal(background.heading.name, "Background shell");
  assert.ok(background.background);

  // A multi-line command still fits on the summary row.
  const long = describe('Bash {"command":"cd /repo &&\\n  python3 -c \\"print(1)\\""}');
  assert.ok(long.heading.subject && !long.heading.subject.includes("\n"));
});

test("a workflow names itself from the meta it must declare", () => {
  const script = [
    "export const meta = {",
    "  name: 'review-changes',",
    "  description: 'Review changed files across dimensions',",
    "  phases: [{ title: 'Review' }, { title: 'Verify' }],",
    "}",
    "phase('Review')",
  ].join("\n");
  assert.deepEqual(workflowMeta(script, "fallback"), {
    name: "review-changes",
    description: "Review changed files across dimensions",
    phases: ["Review", "Verify"],
  });
  // A saved workflow invoked by name carries no script to read.
  assert.deepEqual(workflowMeta("", "find-flaky"), { name: "find-flaky", description: "", phases: [] });

  const view = describe(`Workflow {"script":${JSON.stringify(script)}}`);
  assert.equal(view.kind, "workflow");
  if (view.kind !== "workflow") return;
  // The name is the word, the workflow's own name is the subject, and the stat says
  // how many phases it declares.
  assert.deepEqual(view.heading, { name: "Workflow", subject: "review-changes", stat: "2 phases" });
  assert.deepEqual(view.phases, ["Review", "Verify"]);
});

test("everything else is named by its subject", () => {
  assert.equal(describe('Read {"file_path":"/repo/app/styles/workspaces.css"}').heading.subject, "styles/workspaces.css");
  assert.equal(describe('Grep {"pattern":"runFeedAgent","output_mode":"files_with_matches"}').heading.subject, "runFeedAgent");
  assert.equal(describe('WebFetch {"url":"https://example.com/paper"}').heading.subject, "https://example.com/paper");
  assert.deepEqual(describe('TaskOutput {"task_id":"busr26qyq"}').heading, { name: "Background output", subject: "busr26qyq" });
  assert.equal(describe('KillShell {"shell_id":"busr26qyq"}').heading.name, "Stop background task");
  // No recognised subject: the tool's own name is all the summary can offer.
  const unknown = describe('mcp__thing__do {"weird":1}');
  assert.equal(unknown.kind, "generic");
  assert.deepEqual(unknown.heading, { name: "mcp__thing__do", subject: undefined });
  assert.equal(shortPath("a/b/c/d.ts"), "c/d.ts");
  assert.equal(shortPath("d.ts"), "d.ts");
});

test("a finished background command and a finished agent both report", () => {
  const bash = parseTaskReport('{"status":"completed","summary":"Background command \\"Sleep\\" completed (exit code 0)","usage":null}');
  assert.equal(bash?.status, "completed");
  assert.match(String(bash?.summary), /exit code 0/);
  assert.equal(bash?.totalTokens, undefined);

  const agent = parseTaskReport('{"status":"completed","summary":"HELLO","usage":{"total_tokens":8070,"tool_uses":2,"duration_ms":1274}}');
  assert.equal(agent?.totalTokens, 8070);
  assert.equal(agent?.toolUses, 2);
  assert.equal(agent?.durationMs, 1274);
  assert.equal(parseTaskReport("not json"), null);

  // The id in the Bash result is what a background card names, so the reader can
  // match it to the output the agent reads back later.
  assert.equal(
    backgroundShellId("Command running in background with ID: bd2ocel7m. Output is being written to: /tmp/x.output"),
    "bd2ocel7m",
  );
  assert.equal(backgroundShellId("ran in the foreground"), null);
  assert.equal(backgroundShellId(undefined), null);
});

test("the outline lists what a turn changed, and nothing it merely looked at", async () => {
  const { buildFeedOutline, isAsyncAgentMetadata } = await import("../../app/lib/feed-tool-view.ts");
  const message = (id: string, content: string, extras: Record<string, unknown> = {}) =>
    ({ id, kind: "tool_use", content, ...extras });

  const outline = buildFeedOutline([
    {
      id: "opening",
      userText: "Clean up the dashes in the docs\nand report the count",
      opening: true,
      messages: [
        message("m1", 'Read {"file_path":"/repo/README.md"}'),
        message("m2", 'Bash {"command":"grep -rn dash ."}'),
        message("m3", 'Edit {"file_path":"/repo/docs/spec.md","old_string":"a — b","new_string":"a, b"}'),
        message("m4", 'Bash {"command":"npm test","run_in_background":true}'),
        message("m5", 'Agent {"subagent_type":"Explore","description":"Find every dash","prompt":"…"}'),
        // A subagent's own edit belongs to its card, not to the thread's outline.
        message("m6", 'Edit {"file_path":"/repo/other.md","old_string":"x","new_string":"y"}', { parentToolUseId: "toolu_5" }),
      ],
    },
    { id: "u2", userText: "", opening: false, messages: [] },
  ]);

  // The request's first line becomes the label, and a turn with no text is still
  // reachable: it is a turn that attached something.
  assert.equal(outline[0].label, "Clean up the dashes in the docs");
  assert.equal(outline[1].label, "Attachments");
  // A file read and a foreground command are not listed; one turn can hold ninety.
  assert.deepEqual(outline[0].operations.map((operation) => [operation.kind, operation.heading.name]), [
    ["diff", "Edit"],
    ["shell", "Background shell"],
    ["subagent", "Explore subagent"],
  ]);
  // The change itself is carried, which is what the rail is scanned for.
  assert.equal(outline[0].operations[0].heading.stat, "+1 −1");
  assert.equal(outline[0].operations[0].id, "m3");

  // The launch metadata of an async agent is addressed to the model, not the reader.
  assert.ok(isAsyncAgentMetadata("Async agent launched successfully. (This tool result is internal metadata"));
  assert.ok(!isAsyncAgentMetadata("HELLO"));
  assert.ok(!isAsyncAgentMetadata(undefined));
});
