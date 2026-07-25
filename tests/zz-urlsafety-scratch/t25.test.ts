import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { safeFetch } from "../../app/lib/url-safety.ts";

test("timer accounting inside a test()", async () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let sets = 0;
  let clears = 0;
  (globalThis as unknown as Record<string, unknown>).setTimeout = ((...args: unknown[]) => { sets += 1; return (realSet as never as (...a: unknown[]) => unknown)(...args); });
  (globalThis as unknown as Record<string, unknown>).clearTimeout = ((...args: unknown[]) => { clears += 1; return (realClear as never as (...a: unknown[]) => unknown)(...args); });
  const originalFetch = globalThis.fetch;
  const signals: unknown[] = [];
  let n = 0;
  globalThis.fetch = (async (_i: unknown, init: RequestInit) => {
    n += 1;
    signals.push(init?.signal);
    return n <= 2 ? new Response(null, { status: 302, headers: { location: `https://example.com/h${n}` } }) : new Response("final");
  }) as typeof fetch;
  try {
    await safeFetch(new URL("https://example.com/s"));
    console.log("signals", signals.length, "identical", signals.every((s) => s === signals[0]), "sets", sets, "clears", clears);
    globalThis.fetch = (async () => { throw new Error("boom"); }) as typeof fetch;
    await assert.rejects(() => safeFetch(new URL("https://example.com/s")), /boom/);
    console.log("after failure sets", sets, "clears", clears);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as unknown as Record<string, unknown>).setTimeout = realSet;
    (globalThis as unknown as Record<string, unknown>).clearTimeout = realClear;
  }
});

test("real-fetch loopback reachability inside a test()", async () => {
  let connections = 0;
  const server = net.createServer((socket) => { connections += 1; socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  try {
    await assert.rejects(() => safeFetch(new URL(`https://[::ffff:127.0.0.1]:${port}/`), { timeoutMs: 3000 }));
  } finally {
    server.close();
  }
  await new Promise((r) => setTimeout(r, 50));
  console.log("mapped connections", connections);
});

test("ipv6 loopback bind availability", async () => {
  let connections = 0;
  const server = net.createServer((socket) => { connections += 1; socket.destroy(); });
  let bound = true;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "::1", () => resolve()); });
  } catch (error) {
    bound = false;
    console.log("bind ::1 failed", (error as { code?: string }).code);
  }
  if (!bound) return;
  const port = (server.address() as net.AddressInfo).port;
  try {
    await assert.rejects(() => safeFetch(new URL(`https://[::]:${port}/`), { timeoutMs: 3000 }));
  } finally {
    server.close();
  }
  await new Promise((r) => setTimeout(r, 50));
  console.log("[::] connections", connections);
});
