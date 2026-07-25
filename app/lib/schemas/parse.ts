/**
 * Validation helpers for the app's untrusted edges: HTTP request bodies, JSON
 * on disk, and JSON an agent composed.
 *
 * `await request.json() as T` and `JSON.parse(text) as T` are both lies to the
 * compiler: the value is `any` at runtime and the cast only silences the type
 * checker. If the bytes don't match `T`, nothing notices until a field is read
 * somewhere far from the boundary. Everything here parses against a Zod schema
 * instead, so a mismatch surfaces where it enters the process.
 */
import type { z } from "zod";

/** A parsed value, or the reason it failed. Never throws. */
export type ParseOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

/** Flatten a ZodError into one line: "field: message; field: message". */
export function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/** Validate an already-decoded value against a schema. */
export function parseWith<T>(schema: z.ZodType<T>, value: unknown): ParseOutcome<T> {
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, error: describeZodError(result.error) };
}

/**
 * Parse JSON text and validate it, folding syntax and shape errors together.
 *
 * A syntax error is reported by position only. V8's own SyntaxError message
 * quotes the ~20 characters surrounding the fault, and callers log these
 * messages: for `settings.json` (which holds API tokens) that would copy part of
 * a secret into the log, so the raw message is deliberately not passed through.
 */
export function parseJsonWith<T>(schema: z.ZodType<T>, text: string): ParseOutcome<T> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    const position = error instanceof Error ? /position (\d+)/.exec(error.message)?.[1] : undefined;
    return {
      ok: false,
      error: position ? `Invalid JSON at position ${position}.` : "Invalid JSON.",
    };
  }
  return parseWith(schema, decoded);
}

/**
 * Read and validate a request's JSON body. A body that isn't JSON at all and a
 * body that doesn't match the schema both come back as a failure, so route
 * handlers answer 400 with the specific field at fault instead of throwing
 * deeper in and answering 500.
 */
export async function parseRequest<T>(schema: z.ZodType<T>, request: Request): Promise<ParseOutcome<T>> {
  let decoded: unknown;
  try {
    decoded = await request.json();
  } catch {
    return { ok: false, error: "Send a JSON request body." };
  }
  return parseWith(schema, decoded);
}
