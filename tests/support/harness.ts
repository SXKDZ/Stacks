/**
 * Shared harness for the behavioral test suites.
 *
 * These tests exercise the real modules: an isolated SQLite library per test file
 * and route handlers called in-process as the plain functions they are.
 * That is the difference between these suites and the older structural ones, which
 * only read source files as text and matched regexes against them. A suite that
 * would otherwise reach the network stubs `fetch` itself, next to the assertion
 * that needs it.
 *
 * IMPORTANT: `createTempLibrary()` must run before anything imports a db module.
 * `db/library-paths` resolves the library root once per process from
 * STACKS_LIBRARY_DIR, and `db/bootstrap` caches its init promise, so the
 * environment has to be set at module scope in the test file, and the modules
 * under test have to be pulled in with a dynamic `await import(...)` afterwards.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point the library at a fresh temp directory for this process and remove it on
 * exit. Returns the directory so a test can inspect the files on disk.
 */
export function createTempLibrary(label = "stacks-test"): string {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  process.env.STACKS_LIBRARY_DIR = dir;
  process.on("exit", () => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A JSON POST to a route handler, as the browser or an agent would send it. */
export function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Read a route handler's JSON response, with its status, in one step. */
export async function readJson<T = Record<string, unknown>>(
  response: Response,
): Promise<{ status: number; body: T }> {
  const text = await response.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as unknown as T;
  }
  return { status: response.status, body };
}
