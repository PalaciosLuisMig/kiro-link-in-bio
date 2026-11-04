// Small pure policies about when the Panel asks the API again (task 15.12).

/** Minimum time between two refetches caused by an unknown link (8.11). */
export const REFETCH_MIN_INTERVAL_MS = 5000;

export interface RateLimiter {
  /** True if the action may run now; it records the time when it says yes. */
  tryAcquire(nowMs: number): boolean;
}

/**
 * Lets an action run at most once every `minIntervalMs` (8.11: at most one refetch
 * every 5 s). The first call is always allowed.
 */
export function createRateLimiter(minIntervalMs: number): RateLimiter {
  let lastMs = Number.NEGATIVE_INFINITY;
  return {
    tryAcquire(nowMs) {
      if (nowMs - lastMs < minIntervalMs) {
        return false;
      }
      lastMs = nowMs;
      return true;
    },
  };
}

export interface UnknownLinkTracker {
  /**
   * The ids in a snapshot that the Panel neither shows nor has already given up
   * on. A non-empty answer means "refetch the links and the metrics".
   */
  check(snapshotLinkIds: Iterable<string>, knownIds: ReadonlySet<string>): string[];
  /**
   * Call after refetching the links. Whatever was unknown and is STILL not in the
   * list is ignored from now on (8.11), so a counter of a deleted link does not
   * trigger a refetch forever.
   */
  resolve(knownIds: ReadonlySet<string>): void;
}

export function createUnknownLinkTracker(): UnknownLinkTracker {
  const ignored = new Set<string>();
  let pending: string[] = [];

  return {
    check(snapshotLinkIds, knownIds) {
      pending = [...new Set(snapshotLinkIds)].filter((id) => !knownIds.has(id) && !ignored.has(id));
      return pending;
    },
    resolve(knownIds) {
      for (const id of pending) {
        if (!knownIds.has(id)) {
          ignored.add(id);
        }
      }
      pending = [];
    },
  };
}
