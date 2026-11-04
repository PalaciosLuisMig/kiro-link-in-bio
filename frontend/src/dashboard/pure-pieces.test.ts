// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';

import { ANNOUNCE_INTERVAL_MS, createAnnouncer, formatNewEvents } from './announcer.js';
import { formatClock, formatMinute } from './format.js';
import {
  createRateLimiter,
  createUnknownLinkTracker,
  REFETCH_MIN_INTERVAL_MS,
} from './refresh-policy.js';

// Tests of the small pure pieces of the Panel (task 15.12): the announcer (a summary
// every 10 s at most), the HH:MM:SS format and the "at most once every 5 s" limit
// for asking the API again.
//
// Validates: Requirements 8.11, 9.4, 9.5.

describe('formatNewEvents', () => {
  test('uses the singular for one and the plural otherwise', () => {
    expect(formatNewEvents(1)).toBe('1 evento nuevo');
    expect(formatNewEvents(2)).toBe('2 eventos nuevos');
    expect(formatNewEvents(12)).toBe('12 eventos nuevos');
  });
});

describe('createAnnouncer', () => {
  function setup() {
    vi.useFakeTimers();
    const element = document.createElement('div');
    const announcer = createAnnouncer({
      element,
      now: () => Date.now(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    return { element, announcer };
  }

  test('announces the first events at once', () => {
    const { element, announcer } = setup();
    announcer.add(3);
    expect(element.textContent).toBe('3 eventos nuevos');
    announcer.dispose();
    vi.useRealTimers();
  });

  test('at most one summary every 10 s, adding up what arrives meanwhile (9.4)', async () => {
    const { element, announcer } = setup();
    const said: string[] = [];
    new MutationObserver(() => said.push(element.textContent ?? '')).observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    announcer.add(1); // announced now
    await vi.advanceTimersByTimeAsync(2000);
    announcer.add(4);
    await vi.advanceTimersByTimeAsync(3000);
    announcer.add(7);
    // Still inside the 10 s: nothing new has been said.
    expect(element.textContent).toBe('1 evento nuevo');

    await vi.advanceTimersByTimeAsync(ANNOUNCE_INTERVAL_MS - 5000);
    // 4 + 7 together, once the interval since the last summary has passed.
    expect(element.textContent).toBe('11 eventos nuevos');
    announcer.dispose();
    vi.useRealTimers();
  });

  test('never says two summaries closer than 10 s', async () => {
    const { element, announcer } = setup();
    const times: number[] = [];
    const original = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    expect(original).toBeDefined();
    new MutationObserver(() => times.push(Date.now())).observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    for (let second = 0; second < 60; second += 1) {
      announcer.add(1);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(ANNOUNCE_INTERVAL_MS);
    for (let index = 1; index < times.length; index += 1) {
      expect((times[index] ?? 0) - (times[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        ANNOUNCE_INTERVAL_MS,
      );
    }
    expect(times.length).toBeGreaterThan(3);
    announcer.dispose();
    vi.useRealTimers();
  });

  test('announces what is pending even if nothing else arrives', async () => {
    const { element, announcer } = setup();
    announcer.add(1);
    announcer.add(2); // inside the interval: waits
    expect(element.textContent).toBe('1 evento nuevo');
    await vi.advanceTimersByTimeAsync(ANNOUNCE_INTERVAL_MS);
    expect(element.textContent).toBe('2 eventos nuevos');
    announcer.dispose();
    vi.useRealTimers();
  });

  test('ignores zero or negative counts and stops when disposed', async () => {
    const { element, announcer } = setup();
    announcer.add(0);
    announcer.add(-5);
    expect(element.textContent).toBe('');

    announcer.add(1);
    announcer.add(2);
    announcer.dispose();
    await vi.advanceTimersByTimeAsync(ANNOUNCE_INTERVAL_MS * 2);
    expect(element.textContent).toBe('1 evento nuevo');
    vi.useRealTimers();
  });
});

describe('formatClock and formatMinute', () => {
  test('HH:MM:SS in the given time zone, with a 24-hour clock (9.5)', () => {
    expect(formatClock('2026-11-03T09:05:03.000Z', 'UTC')).toBe('09:05:03');
    expect(formatClock('2026-11-03T00:00:00.000Z', 'UTC')).toBe('00:00:00');
    expect(formatClock('2026-11-03T23:59:59.000Z', 'UTC')).toBe('23:59:59');
    expect(formatClock('2026-11-03T15:30:00.000Z', 'UTC')).not.toMatch(/[ap]\.? ?m/i);
  });

  test('follows the time zone: the same instant in two zones', () => {
    expect(formatClock('2026-11-03T12:00:00.000Z', 'UTC')).toBe('12:00:00');
    expect(formatClock('2026-11-03T12:00:00.000Z', 'Asia/Tokyo')).toBe('21:00:00');
    expect(formatClock('2026-11-03T12:00:00.000Z', 'America/New_York')).toBe('07:00:00');
  });

  test('an unreadable time shows a placeholder instead of breaking', () => {
    expect(formatClock('not a date', 'UTC')).toBe('--:--:--');
    expect(formatClock('', 'UTC')).toBe('--:--:--');
  });

  test('a minute start is HH:MM', () => {
    const startSec = Date.UTC(2026, 10, 3, 9, 5, 0) / 1000;
    expect(formatMinute(startSec, 'UTC')).toBe('09:05');
    expect(formatMinute(startSec, 'Asia/Tokyo')).toBe('18:05');
  });
});

describe('createRateLimiter', () => {
  test('allows the first call and then at most one every 5 s (8.11)', () => {
    const limiter = createRateLimiter(REFETCH_MIN_INTERVAL_MS);
    expect(REFETCH_MIN_INTERVAL_MS).toBe(5000);
    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(1)).toBe(false);
    expect(limiter.tryAcquire(4999)).toBe(false);
    expect(limiter.tryAcquire(5000)).toBe(true);
    expect(limiter.tryAcquire(9999)).toBe(false);
    expect(limiter.tryAcquire(10_000)).toBe(true);
  });

  test('a refused call does not move the window', () => {
    const limiter = createRateLimiter(5000);
    expect(limiter.tryAcquire(1000)).toBe(true);
    expect(limiter.tryAcquire(4000)).toBe(false);
    expect(limiter.tryAcquire(6000)).toBe(true); // 5 s after 1000, not after 4000
  });
});

describe('createUnknownLinkTracker', () => {
  test('reports the ids the Panel does not show, once resolved it stops asking', () => {
    const tracker = createUnknownLinkTracker();
    const known = new Set(['a', 'b']);

    expect(tracker.check(['a', 'b'], known)).toEqual([]);
    expect(tracker.check(['a', 'c'], known)).toEqual(['c']);

    // After refetching, `c` is still not in the list: it is ignored from now on.
    tracker.resolve(known);
    expect(tracker.check(['a', 'c'], known)).toEqual([]);
  });

  test('an id that did appear in the refetched list is known, not ignored', () => {
    const tracker = createUnknownLinkTracker();
    expect(tracker.check(['x'], new Set())).toEqual(['x']);
    tracker.resolve(new Set(['x']));
    // It is known now. If it later disappears (deleted), it counts as unknown again.
    expect(tracker.check(['x'], new Set())).toEqual(['x']);
  });

  test('repeated ids are reported once', () => {
    const tracker = createUnknownLinkTracker();
    expect(tracker.check(['c', 'c', 'd'], new Set())).toEqual(['c', 'd']);
  });
});
