import assert from "node:assert/strict";
import test from "node:test";
import { createConcurrencyLimiter } from "../../app/lib/summary-concurrency";

test("limits concurrent operations while allowing queued work to finish", async () => {
  const withSlot = createConcurrencyLimiter(2);
  let active = 0;
  let maximumActive = 0;
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const waiting: number[] = [];

  const run = (id: number, gate?: Promise<void>) => withSlot(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await gate;
    active -= 1;
    return id;
  }, () => waiting.push(id));

  const first = run(1, firstGate);
  const second = run(2, secondGate);
  const third = run(3);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(waiting, [3]);
  assert.equal(maximumActive, 2);

  releaseFirst();
  assert.equal(await third, 3);
  releaseSecond();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.equal(maximumActive, 2);
});

test("releases a slot after an operation fails", async () => {
  const withSlot = createConcurrencyLimiter(1);
  await assert.rejects(withSlot(async () => { throw new Error("failed"); }), /failed/);
  assert.equal(await withSlot(async () => "next"), "next");
});

test("rejects invalid concurrency limits", () => {
  assert.throws(() => createConcurrencyLimiter(0), /positive integer/);
  assert.throws(() => createConcurrencyLimiter(1.5), /positive integer/);
});
