/**
 * Whether a GitHub sync pass is running right now.
 *
 * The sync route already refused to start a second pass; this moves that flag
 * somewhere the turn actions can read it. A rewind or a retry that lands mid-pass can
 * delete a comment the inbound half has just ingested, which loses a reply written on
 * a phone with nothing to show the user it arrived. They refuse instead and say why.
 *
 * A single Node process serves every request, so a module-scope flag is enough. It is
 * cleared in a finally block, and a process restart clears it by construction.
 */
let syncing = false;

export function isGithubSyncRunning(): boolean {
  return syncing;
}

/** Claim the pass. False when one is already running, which the caller reports as 409. */
export function claimGithubSync(): boolean {
  if (syncing) return false;
  syncing = true;
  return true;
}

export function releaseGithubSync(): void {
  syncing = false;
}
