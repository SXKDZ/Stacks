/**
 * Did an agent process stop, or did it fail?
 *
 * Extracted so it can be tested without spawning anything, and because the answer
 * is not obvious. The `claude` CLI traps SIGTERM and exits 143 on its own rather
 * than dying from the signal, so Node reports `code: 143, signal: null`; a check on
 * `signal` alone missed every user-initiated stop and reported it as a crash.
 *
 * A graceful interrupt (a stream-json control request) is different again: the turn
 * ends with `is_error` and the process exits 1, which is indistinguishable from a
 * real failure by exit status. Only the caller knows, hence `stopRequested`.
 */
export interface AgentExit {
  code: number | null;
  signal: NodeJS.Signals | string | null;
  /** True when Stacks asked this run to stop (Stop pressed, or interrupt-then-send). */
  stopRequested?: boolean;
}

export function isStoppedExit(exit: AgentExit): boolean {
  return exit.stopRequested === true
    || exit.signal === "SIGTERM"
    || exit.signal === "SIGKILL"
    // 128 + signal number, for a process that handled the signal itself.
    || exit.code === 143
    || exit.code === 137;
}
