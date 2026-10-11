// ============================================================================
// KEYED TASK QUEUE — serialize async jobs that must not interleave per key.
//
// Why this exists (audit F-04): full-recompute aggregate triggers run
// fire-and-forget. Two overlapping executions for the SAME user can finish
// out of order — the older snapshot then overwrites the newer one and the
// stored aggregate silently reverts. Jobs that touch the same per-key state
// (e.g. `investments-aggregates` per userId) must run sequentially in
// submission order, while jobs for different keys stay concurrent.
// ============================================================================

export interface KeyedTaskQueue {
  /**
   * Run `task` serialized per `key`.
   *
   * - Tasks with the SAME key execute strictly in submission order
   *   (each waits for the previous one to settle, success or failure).
   * - Tasks with DIFFERENT keys run concurrently.
   * - A rejected task never poisons the chain: the next queued task still
   *   runs, and the rejection propagates only to that task's own caller.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T>;

  /** Number of keys currently with a pending/settling tail (observability). */
  readonly size: number;
}

export function createKeyedTaskQueue(): KeyedTaskQueue {
  // Tail of the chain per key. Always a fulfilled promise reference so a
  // failed task cannot break subsequent ones — the caller of the failing
  // task still receives the rejection via the returned promise.
  const tails = new Map<string, Promise<void>>();

  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      const next = prev.then(task);
      const safeTail: Promise<void> = next.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, safeTail);
      // Self-clean once settled: drop the entry if no newer task replaced it,
      // so idle keys do not accumulate in the map.
      void safeTail.then(() => {
        if (tails.get(key) === safeTail) tails.delete(key);
      });
      return next;
    },
    get size() {
      return tails.size;
    },
  };
}
