/**
 * The saved-configuration routes: skills and workflows.
 *
 * Both replace a stored list wholesale, so the failure that matters is a
 * malformed request being treated as "save nothing" rather than as an error. Both
 * did exactly that, which silently discarded work the user had done.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createTempLibrary, jsonRequest, readJson } from "../support/harness.ts";

createTempLibrary("stacks-settings-routes");

const skillsRoute = import("../../app/api/feed/skills/route.ts");
const workflowsRoute = import("../../app/api/feed/workflows/route.ts");

const SKILLS_URL = "http://127.0.0.1/api/feed/skills";
const WORKFLOWS_URL = "http://127.0.0.1/api/feed/workflows";

test("saving skills keeps exactly what was posted", async () => {
  const { POST, GET } = await skillsRoute;
  const saved = await readJson<{ skills: Array<{ id: string; label: string; icon: string; prompt: string }> }>(
    await POST(jsonRequest(SKILLS_URL, {
      skills: [{ id: "mine", label: "My skill", icon: "sparkles", prompt: "do the thing" }],
    })),
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.body.skills.length, 1);
  assert.equal(saved.body.skills[0].label, "My skill");

  const read = await readJson<{ skills: Array<{ label: string }> }>(await GET());
  assert.deepEqual(read.body.skills.map((skill) => skill.label), ["My skill"]);
});

test("a malformed skills body is refused, not treated as a reset", async () => {
  // normalizeFeedSkills falls back to the seed defaults for a non-array, so a bad
  // request used to answer 200 having replaced the user's skills with the
  // built-in set.
  const { POST, GET } = await skillsRoute;
  for (const body of [{}, { skills: "nope" }, { skills: 42 }, { notSkills: [] }]) {
    const result = await readJson<{ error?: string }>(await POST(jsonRequest(SKILLS_URL, body)));
    assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.ok(result.body.error);
  }
  // The previously saved skill is still there.
  const read = await readJson<{ skills: Array<{ label: string }> }>(await GET());
  assert.deepEqual(read.body.skills.map((skill) => skill.label), ["My skill"]);
});

test("an explicitly empty skills array is a legitimate save", async () => {
  const { POST } = await skillsRoute;
  const result = await readJson<{ skills: unknown[] }>(await POST(jsonRequest(SKILLS_URL, { skills: [] })));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.skills, []);
});

test("saving workflows derives name and description from the script's own meta", async () => {
  const { POST } = await workflowsRoute;
  const script = 'export const meta = { name: "from-meta", description: "the real description" };\nlog("hi");';
  const saved = await readJson<{ workflows: Array<{ id: string; name: string; description: string }> }>(
    await POST(jsonRequest(WORKFLOWS_URL, {
      workflows: [{ id: "w1", name: "ignored", description: "ignored too", script }],
    })),
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.body.workflows.length, 1);
  // The stored list describes what the script actually is, not what was posted.
  assert.equal(saved.body.workflows[0].name, "from-meta");
  assert.equal(saved.body.workflows[0].description, "the real description");
});

test("a malformed workflows body is refused, not treated as a delete-all", async () => {
  // normalize() returns [] for any non-array, and the route wrote that over the
  // saved set: `{}` or a non-JSON body silently deleted every saved workflow.
  const { POST, GET } = await workflowsRoute;
  for (const body of [{}, { workflows: "nope" }, { workflows: null }]) {
    const result = await readJson<{ error?: string }>(await POST(jsonRequest(WORKFLOWS_URL, body)));
    assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.ok(result.body.error);
  }
  const read = await readJson<{ workflows: Array<{ name: string }> }>(await GET());
  assert.deepEqual(read.body.workflows.map((workflow) => workflow.name), ["from-meta"]);
});

test("a workflow entry with no script is dropped rather than stored empty", async () => {
  const { POST } = await workflowsRoute;
  const result = await readJson<{ workflows: unknown[] }>(
    await POST(jsonRequest(WORKFLOWS_URL, {
      workflows: [
        { id: "keep", script: 'export const meta = { name: "keeper", description: "d" };' },
        { id: "drop", script: "   " },
        { id: "also-drop" },
      ],
    })),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.workflows.length, 1, "only the entry with a real script is stored");
});
