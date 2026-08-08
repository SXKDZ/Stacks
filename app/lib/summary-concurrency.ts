/**
 * Keep long-lived summary requests from occupying every browser connection to
 * the app. Interactive work (saving an edit, opening a paper, loading the
 * activity log) must retain request capacity while a batch is being summarized.
 */
export const MAX_CONCURRENT_SUMMARIES = 3;

type AsyncOperation<Result> = () => Promise<Result>;

export function createConcurrencyLimiter(maxConcurrent: number) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("Concurrency must be a positive integer.");
  }

  let active = 0;
  const waiting: Array<() => void> = [];

  async function acquire(onWait?: () => void): Promise<void> {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    onWait?.();
    // A release transfers its existing slot directly to this waiter. Keeping
    // `active` unchanged during that hand-off prevents a newer request from
    // stealing the slot between resolve() and this continuation resuming.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function release(): void {
    const next = waiting.shift();
    if (next) {
      next();
      return;
    }
    active -= 1;
  }

  return async function withSlot<Result>(
    operation: AsyncOperation<Result>,
    onWait?: () => void,
  ): Promise<Result> {
    await acquire(onWait);
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

export const withSummarySlot = createConcurrencyLimiter(MAX_CONCURRENT_SUMMARIES);
