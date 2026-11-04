// Announcer of new activity for assistive technology (task 15.11, Requirement 9.4).
//
// A polite live region that says how many events arrived, at most once every 10
// seconds, so a busy demo does not bury a screen reader in messages.

/** At most one summary in this time. */
export const ANNOUNCE_INTERVAL_MS = 10_000;

/** "1 evento nuevo" or "12 eventos nuevos". */
export function formatNewEvents(count: number): string {
  return count === 1 ? '1 evento nuevo' : `${count} eventos nuevos`;
}

export interface AnnouncerDeps {
  /** The `aria-live="polite"` element that receives the text. */
  readonly element: HTMLElement;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly intervalMs?: number;
}

export interface Announcer {
  /** Records `count` new events. Does nothing for 0 or less. */
  add(count: number): void;
  /** Cancels a pending announcement. */
  dispose(): void;
}

/**
 * Creates the announcer. The first events are announced at once; later ones are
 * added up and announced together when the interval since the last summary ends,
 * so nothing is lost and nothing is said more than once per interval.
 */
export function createAnnouncer(deps: AnnouncerDeps): Announcer {
  const interval = deps.intervalMs ?? ANNOUNCE_INTERVAL_MS;
  let pending = 0;
  let lastAt = Number.NEGATIVE_INFINITY;
  let timer: unknown;

  const announce = (): void => {
    timer = undefined;
    if (pending === 0) {
      return;
    }
    deps.element.textContent = formatNewEvents(pending);
    pending = 0;
    lastAt = deps.now();
  };

  return {
    add(count) {
      if (count <= 0) {
        return;
      }
      pending += count;
      if (timer !== undefined) {
        return; // already waiting: the count is added to the pending summary
      }
      const wait = lastAt + interval - deps.now();
      if (wait <= 0) {
        announce();
      } else {
        timer = deps.setTimeout(announce, wait);
      }
    },
    dispose() {
      if (timer !== undefined) {
        deps.clearTimeout(timer);
        timer = undefined;
      }
      pending = 0;
    },
  };
}
