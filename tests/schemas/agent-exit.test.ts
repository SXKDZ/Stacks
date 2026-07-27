/**
 * Telling a stop apart from a failure when an agent process exits.
 *
 * This looks trivial and is not. The `claude` CLI traps SIGTERM and exits 143
 * itself rather than dying from the signal, so Node reports `code: 143,
 * signal: null` — verified directly:
 *
 *   plain `sleep`, killed          -> code=null signal=SIGTERM
 *   a process that traps and exits -> code=143  signal=null
 *
 * A check on `signal` alone therefore missed every user-initiated stop, and the
 * thread showed "The agent reported an error" and "exited with code 143" for
 * something the user did on purpose.
 *
 * A graceful interrupt (a stream-json control request) exits 1 with the turn
 * reported as `is_error`, which is why the explicit stop flag has to win over both
 * the code and the signal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isStoppedExit } from "../../app/lib/agent-exit.ts";

test("a signalled exit is a stop", () => {
  assert.equal(isStoppedExit({ code: null, signal: "SIGTERM" }), true);
  assert.equal(isStoppedExit({ code: null, signal: "SIGKILL" }), true);
});

test("the trapped-signal exit codes are stops", () => {
  // 128 + 15 and 128 + 9: what a process reports when it handles the signal itself.
  assert.equal(isStoppedExit({ code: 143, signal: null }), true);
  assert.equal(isStoppedExit({ code: 137, signal: null }), true);
});

test("an explicit stop request wins over any exit code", () => {
  // A graceful control-request interrupt exits 1, which is otherwise a failure.
  assert.equal(isStoppedExit({ code: 1, signal: null, stopRequested: true }), true);
  assert.equal(isStoppedExit({ code: 0, signal: null, stopRequested: true }), true);
  assert.equal(isStoppedExit({ code: 2, signal: null, stopRequested: true }), true);
});

test("a real failure stays a failure", () => {
  // Nothing asked it to stop and it did not exit on a signal: this is an error.
  assert.equal(isStoppedExit({ code: 1, signal: null }), false);
  assert.equal(isStoppedExit({ code: 2, signal: null }), false);
  assert.equal(isStoppedExit({ code: 127, signal: null }), false, "127 = command not found");
});

test("a clean exit is not a stop", () => {
  assert.equal(isStoppedExit({ code: 0, signal: null }), false);
});
