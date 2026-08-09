export interface AgentFailureContext {
  resultEvent?: Record<string, unknown> | null;
  stderr?: string;
  code?: number | null;
  signal?: string | null;
  processError?: string;
}

/**
 * Preserve the complete evidence for one failed Claude turn.
 *
 * Claude's result text and stderr are both allowed to be empty. The structured
 * result event still carries fields such as its subtype, stop reason, usage,
 * and permission denials, so retaining the whole event is what makes a later
 * failure diagnosable instead of reducing it to "exited with code 1".
 */
export function formatAgentFailure({ resultEvent, stderr = "", code, signal, processError }: AgentFailureContext): string {
  const details: string[] = [];
  const cleanProcessError = processError?.trim();
  if (cleanProcessError) details.push(`Process error:\n${cleanProcessError}`);

  if (resultEvent) {
    details.push(`Agent result event:\n${JSON.stringify(resultEvent, null, 2)}`);
  }

  const cleanStderr = stderr.trim();
  if (cleanStderr) details.push(`Standard error:\n${cleanStderr}`);

  if (code !== undefined || signal !== undefined) {
    details.push(`Process exit:\ncode: ${code ?? "none"}\nsignal: ${signal ?? "none"}`);
  }

  if (!details.length) details.push("No diagnostic data was returned by the agent process.");
  return `Agent turn failed.\n\n${details.join("\n\n")}`;
}
