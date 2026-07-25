/**
 * Shared harness for the behavioral test suites.
 *
 * These tests exercise the real modules: an isolated SQLite library per test
 * file, route handlers called in-process as the plain functions they are, and
 * `fetch` stubbed so nothing reaches the network. That is the difference between
 * these suites and the older structural ones, which only read source files as
 * text and matched regexes against them.
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

/** One recorded outbound call made through the stubbed `fetch`. */
export interface RecordedCall {
  url: string;
  method: string;
  body: string | null;
  headers: Record<string, string>;
}

export interface FetchStub {
  /** Every call made, in order. */
  calls: RecordedCall[];
  /** Restore the real `fetch`. */
  restore: () => void;
}

/**
 * Replace `globalThis.fetch` with a router over exact-or-prefix URL matchers, so
 * a suite can assert on what the code *sent* as well as how it handled the
 * reply. An unmatched URL throws, which keeps an accidental real network call
 * from silently passing.
 *
 * A handler returns either a Response or a plain object (sent as JSON 200).
 */
export function stubFetch(
  routes: Array<{
    match: (url: string, init: RequestInit | undefined) => boolean;
    respond: (url: string, init: RequestInit | undefined) => Response | unknown;
  }>,
): FetchStub {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url, method, body, headers });
    const route = routes.find((candidate) => candidate.match(url, init));
    if (!route) {
      throw new Error(`Unstubbed fetch in test: ${method} ${url}`);
    }
    const result = route.respond(url, init);
    return result instanceof Response ? result : Response.json(result);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
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
