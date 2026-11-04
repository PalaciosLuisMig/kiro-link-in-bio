import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import type { ActivityEvent, MetricsSnapshot } from '@link-in-bio/shared';

import {
  advanceClock,
  applySnapshot,
  FEED_LIMIT,
  initialState,
  MINUTES_SHOWN,
  minuteStartSec,
  windowMinutes,
  windowStartSec,
  type DashboardState,
} from './store.js';
import {
  BASE_TIME_MS,
  consistentEvent,
  localNowMs,
  snapshotArb,
  snapshotInEpoch,
} from './testing/arbitraries.js';

// Property tests of the Panel reducer (tasks 15.2 to 15.5).
//
// Feature: link-in-bio, Property 10: Reductor del Panel (monotonía, idempotencia y conmutatividad)
// Feature: link-in-bio, Property 11: Épocas distintas
// Feature: link-in-bio, Property 12: Ventana de 60 Minutos
// Feature: link-in-bio, Property 13: Feed de actividad
//
// Validates: Requirements 7.3, 8.3, 8.4, 8.5, 8.6, 8.9, 8.10, 9.1, 9.2, 10.3, 16.6.

const numRuns = Number(import.meta.env.FC_NUM_RUNS ?? '100');

const EPOCH = BASE_TIME_MS;

const applyAll = (
  steps: readonly (readonly [MetricsSnapshot, number])[],
  from: DashboardState = initialState(),
): DashboardState =>
  steps.reduce((state, [snapshot, now]) => applySnapshot(state, snapshot, now), from);

const pair = (epoch: number) => fc.tuple(snapshotInEpoch(epoch), localNowMs);

describe('Property 10: monotonic, idempotent and commutative inside one epoch', () => {
  test('monotonic: no counter ever goes down', () => {
    fc.assert(
      fc.property(pair(EPOCH), pair(EPOCH), (first, second) => {
        const before = applyAll([first]);
        const after = applyAll([second], before);

        expect(after.totals.clicks).toBeGreaterThanOrEqual(before.totals.clicks);
        expect(after.totals.visits).toBeGreaterThanOrEqual(before.totals.visits);
        for (const [id, clicks] of before.links) {
          expect(after.links.get(id) ?? -1).toBeGreaterThanOrEqual(clicks);
        }
        for (const [name, counts] of before.channels) {
          expect(after.channels.get(name)?.clicks ?? -1).toBeGreaterThanOrEqual(counts.clicks);
          expect(after.channels.get(name)?.visits ?? -1).toBeGreaterThanOrEqual(counts.visits);
        }
        // A minute that is still in the window never loses clicks.
        for (const [sec, clicks] of before.minutes) {
          if (after.minutes.has(sec)) {
            expect(after.minutes.get(sec) ?? -1).toBeGreaterThanOrEqual(clicks);
          }
        }
        expect(after.windowEndSec).toBeGreaterThanOrEqual(before.windowEndSec);
      }),
      { numRuns },
    );
  });

  test('a smaller value is ignored and the rest of the snapshot is applied (8.5)', () => {
    const state = applyAll([
      [
        {
          epoch: EPOCH,
          serverTime: new Date(BASE_TIME_MS).toISOString(),
          totals: { clicks: 10, visits: 4 },
          links: { a: 7 },
          minutes: {},
          channels: { qr: { clicks: 5, visits: 2 } },
          events: [],
        },
        BASE_TIME_MS,
      ],
    ]);
    const next = applySnapshot(
      state,
      {
        epoch: EPOCH,
        serverTime: new Date(BASE_TIME_MS).toISOString(),
        totals: { clicks: 3, visits: 9 }, // clicks lower, visits higher
        links: { a: 1, b: 2 }, // a lower, b new
        minutes: {},
        channels: { qr: { clicks: 1, visits: 6 } },
        events: [],
      },
      BASE_TIME_MS,
    );
    expect(next.totals).toEqual({ clicks: 10, visits: 9 });
    expect(next.links.get('a')).toBe(7);
    expect(next.links.get('b')).toBe(2);
    expect(next.channels.get('qr')).toEqual({ clicks: 5, visits: 6 });
  });

  test('idempotent: applying the same snapshot twice changes nothing', () => {
    fc.assert(
      fc.property(pair(EPOCH), pair(EPOCH), (setup, [snapshot, now]) => {
        const once = applyAll([[snapshot, now]], applyAll([setup]));
        const twice = applySnapshot(once, snapshot, now);
        expect(twice).toEqual(once);
      }),
      { numRuns },
    );
  });

  test('commutative: two snapshots give the same state in either order', () => {
    fc.assert(
      fc.property(pair(EPOCH), pair(EPOCH), (a, b) => {
        expect(applyAll([a, b])).toEqual(applyAll([b, a]));
      }),
      { numRuns },
    );
  });

  test('commutative for any order of three snapshots (so it also associates)', () => {
    fc.assert(
      fc.property(pair(EPOCH), pair(EPOCH), pair(EPOCH), (a, b, c) => {
        const reference = applyAll([a, b, c]);
        expect(applyAll([c, a, b])).toEqual(reference);
        expect(applyAll([b, c, a])).toEqual(reference);
        expect(applyAll([c, b, a])).toEqual(reference);
      }),
      { numRuns },
    );
  });

  test('the clock offset comes from the snapshot with the greatest server time', () => {
    fc.assert(
      fc.property(pair(EPOCH), pair(EPOCH), (a, b) => {
        const serverA = Date.parse(a[0].serverTime);
        const serverB = Date.parse(b[0].serverTime);
        fc.pre(serverA !== serverB);
        const [newest, oldest] = serverA > serverB ? [a, b] : [b, a];
        // However they arrive, the offset is the one measured with the newest.
        for (const order of [
          [newest, oldest],
          [oldest, newest],
        ] as const) {
          const state = applyAll([...order]);
          expect(state.serverTimeMs).toBe(Date.parse(newest[0].serverTime));
          expect(state.clockOffsetMs).toBe(Date.parse(newest[0].serverTime) - newest[1]);
        }
      }),
      { numRuns },
    );
  });
});

describe('Property 11: different epochs', () => {
  test('a snapshot of an older epoch is discarded whole: the state is untouched', () => {
    fc.assert(
      fc.property(
        pair(EPOCH),
        snapshotArb({ epoch: fc.integer({ min: 0, max: EPOCH - 1 }) }),
        localNowMs,
        (setup, older, now) => {
          const state = applyAll([setup]);
          expect(applySnapshot(state, older, now)).toBe(state);
        },
      ),
      { numRuns },
    );
  });

  test('a snapshot of a newer epoch replaces the state, whatever it was', () => {
    fc.assert(
      fc.property(
        fc.array(pair(EPOCH), { maxLength: 3 }),
        snapshotArb({ epoch: fc.integer({ min: EPOCH + 1, max: EPOCH + 1_000_000 }) }),
        localNowMs,
        (history, newer, now) => {
          const replaced = applySnapshot(applyAll(history), newer, now);
          expect(replaced).toEqual(applySnapshot(initialState(), newer, now));
          expect(replaced.epoch).toBe(newer.epoch);
        },
      ),
      { numRuns },
    );
  });

  test('a reset shows zero counters and an empty feed before applying the new values (16.6)', () => {
    const reset = applySnapshot(
      applyAll([
        [
          {
            epoch: EPOCH,
            serverTime: new Date(BASE_TIME_MS).toISOString(),
            totals: { clicks: 50, visits: 20 },
            links: { a: 30 },
            minutes: { [new Date(BASE_TIME_MS).toISOString()]: 50 },
            channels: { qr: { clicks: 50, visits: 20 } },
            events: [
              { id: 'old', type: 'visit', channel: 'qr', at: new Date(BASE_TIME_MS).toISOString() },
            ],
          },
          BASE_TIME_MS,
        ],
      ]),
      {
        epoch: EPOCH + 5000,
        serverTime: new Date(BASE_TIME_MS + 5000).toISOString(),
        totals: { clicks: 0, visits: 0 },
        links: {},
        minutes: {},
        channels: {},
        events: [],
      },
      BASE_TIME_MS + 5000,
    );
    expect(reset.totals).toEqual({ clicks: 0, visits: 0 });
    expect(reset.links.size).toBe(0);
    expect(reset.channels.size).toBe(0);
    expect(reset.events).toEqual([]);
    expect(windowMinutes(reset).every((bar) => bar.clicks === 0)).toBe(true);
  });

  test('after a newer epoch, the values of the previous epochs are discarded', () => {
    fc.assert(
      fc.property(pair(EPOCH), snapshotInEpoch(EPOCH + 10), localNowMs, (old, fresh, now) => {
        const afterReset = applySnapshot(applyAll([old]), fresh, now);
        const late = applySnapshot(afterReset, old[0], old[1]);
        expect(late).toBe(afterReset);
      }),
      { numRuns },
    );
  });
});

describe('Property 12: the 60-minute window', () => {
  const start = (state: DashboardState): number => windowStartSec(state.windowEndSec);

  test('there are exactly 60 consecutive minutes ending at the window end, zero where empty', () => {
    fc.assert(
      fc.property(fc.array(pair(EPOCH), { minLength: 1, maxLength: 4 }), (history) => {
        const state = applyAll(history);
        const bars = windowMinutes(state);
        expect(bars).toHaveLength(MINUTES_SHOWN);
        expect(bars[0]?.startSec).toBe(start(state));
        expect(bars[MINUTES_SHOWN - 1]?.startSec).toBe(state.windowEndSec);
        bars.forEach((bar, index) => {
          expect(bar.startSec).toBe(start(state) + index * 60);
          expect(bar.clicks).toBe(state.minutes.get(bar.startSec) ?? 0);
        });
      }),
      { numRuns },
    );
  });

  test('a minute before the window is ignored; the rest of the snapshot is applied (8.9)', () => {
    fc.assert(
      fc.property(pair(EPOCH), fc.integer({ min: 1, max: 500 }), (anchor, clicks) => {
        const state = applyAll([anchor]);
        const tooOld = new Date((start(state) - 60) * 1000).toISOString();
        const next = applySnapshot(
          state,
          {
            epoch: EPOCH,
            serverTime: new Date(state.serverTimeMs).toISOString(),
            totals: { clicks: 0, visits: 0 },
            links: {},
            minutes: { [tooOld]: clicks },
            channels: {},
            events: [],
          },
          anchor[1],
        );
        expect(next.minutes.has(start(state) - 60)).toBe(false);
        expect(next.windowEndSec).toBe(state.windowEndSec);
      }),
      { numRuns },
    );
  });

  test('a minute after the window moves it forward and is applied (8.10)', () => {
    fc.assert(
      fc.property(pair(EPOCH), fc.integer({ min: 1, max: 30 }), (anchor, ahead) => {
        const state = applyAll([anchor]);
        const futureSec = state.windowEndSec + ahead * 60;
        const next = applySnapshot(
          state,
          {
            epoch: EPOCH,
            serverTime: new Date(state.serverTimeMs).toISOString(),
            totals: { clicks: 0, visits: 0 },
            links: {},
            minutes: { [new Date(futureSec * 1000).toISOString()]: 7 },
            channels: {},
            events: [],
          },
          anchor[1],
        );
        expect(next.windowEndSec).toBe(futureSec);
        expect(next.minutes.get(futureSec)).toBe(7);
        expect(windowMinutes(next)).toHaveLength(MINUTES_SHOWN);
      }),
      { numRuns },
    );
  });

  test('the window only moves forward, with snapshots and with the clock', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            pair(EPOCH).map((p) => ({ kind: 'snapshot' as const, p })),
            localNowMs.map((now) => ({ kind: 'tick' as const, now })),
          ),
          { maxLength: 8 },
        ),
        (steps) => {
          let state = initialState();
          let previousEnd = state.windowEndSec;
          for (const step of steps) {
            state =
              step.kind === 'snapshot'
                ? applySnapshot(state, step.p[0], step.p[1])
                : advanceClock(state, step.now);
            expect(state.windowEndSec).toBeGreaterThanOrEqual(previousEnd);
            previousEnd = state.windowEndSec;
            // Whatever is kept lies inside the window.
            for (const sec of state.minutes.keys()) {
              expect(sec).toBeGreaterThanOrEqual(windowStartSec(state.windowEndSec));
              expect(sec).toBeLessThanOrEqual(state.windowEndSec);
            }
          }
        },
      ),
      { numRuns },
    );
  });

  test('a new minute adds a bar at 0 and drops the oldest (8.4)', () => {
    fc.assert(
      fc.property(pair(EPOCH), fc.integer({ min: 1, max: 59 }), (anchor, minutesLater) => {
        const state = applyAll([anchor]);
        // The corrected clock moves `minutesLater` minutes past the window end.
        const localNow =
          (state.windowEndSec + minutesLater * 60) * 1000 - state.clockOffsetMs + 1000;
        const next = advanceClock(state, localNow);
        const before = windowMinutes(state);
        const after = windowMinutes(next);

        expect(next.windowEndSec).toBe(minuteStartSec(localNow + state.clockOffsetMs));
        expect(after).toHaveLength(MINUTES_SHOWN);
        // The newest bars are new and empty; the oldest ones left.
        expect(after.slice(-minutesLater).every((bar) => bar.clicks === 0)).toBe(true);
        expect(after[0]?.startSec).toBe((before[0]?.startSec ?? 0) + minutesLater * 60);
      }),
      { numRuns },
    );
  });

  test('advancing the clock without a new minute returns the very same state', () => {
    fc.assert(
      fc.property(pair(EPOCH), (anchor) => {
        const state = applyAll([anchor]);
        const sameMinute = (state.windowEndSec + 30) * 1000 - state.clockOffsetMs;
        expect(advanceClock(state, sameMinute)).toBe(state);
        expect(advanceClock(initialState(), 123)).toEqual(initialState());
      }),
      { numRuns },
    );
  });
});

describe('Property 13: the activity feed', () => {
  const idsOf = (events: readonly ActivityEvent[]): string[] => events.map((event) => event.id);

  /** The feed the reducer must produce: a set by id, newest first, cut to 20. */
  const modelFeed = (...lists: ActivityEvent[][]): string[] => {
    const byId = new Map<string, ActivityEvent>();
    for (const event of lists.flat()) {
      byId.set(event.id, event);
    }
    return [...byId.values()]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? -1 : 1))
      .slice(0, FEED_LIMIT)
      .map((event) => event.id);
  };

  const snapshotWithEvents = snapshotArb({ epoch: fc.constant(EPOCH), event: consistentEvent });

  test('never more than 20 events, with no repeated id, newest first (9.1, 9.2)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(snapshotWithEvents, localNowMs), { maxLength: 4 }),
        (history) => {
          const feed = applyAll(history).events;
          expect(feed.length).toBeLessThanOrEqual(FEED_LIMIT);
          expect(new Set(idsOf(feed)).size).toBe(feed.length);
          for (let index = 1; index < feed.length; index += 1) {
            expect(Date.parse(feed[index - 1]?.at ?? '')).toBeGreaterThanOrEqual(
              Date.parse(feed[index]?.at ?? ''),
            );
          }
        },
      ),
      { numRuns },
    );
  });

  test('it is the 20 newest of everything received, in any order', () => {
    fc.assert(
      fc.property(snapshotWithEvents, snapshotWithEvents, localNowMs, (a, b, now) => {
        const expected = modelFeed(a.events, b.events);
        expect(
          idsOf(
            applyAll([
              [a, now],
              [b, now],
            ]).events,
          ),
        ).toEqual(expected);
        expect(
          idsOf(
            applyAll([
              [b, now],
              [a, now],
            ]).events,
          ),
        ).toEqual(expected);
      }),
      { numRuns },
    );
  });

  test('events with the same time are ordered by id, so the feed is stable', () => {
    const at = new Date(BASE_TIME_MS).toISOString();
    const tied: ActivityEvent[] = ['c', 'a', 'b'].map((id) => ({
      id,
      type: 'visit',
      channel: 'qr',
      at,
    }));
    const snapshot: MetricsSnapshot = {
      epoch: EPOCH,
      serverTime: at,
      totals: { clicks: 0, visits: 3 },
      links: {},
      minutes: {},
      channels: {},
      events: tied,
    };
    expect(idsOf(applySnapshot(initialState(), snapshot, BASE_TIME_MS).events)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  test('an event received again is not shown twice', () => {
    fc.assert(
      fc.property(snapshotWithEvents, localNowMs, (snapshot, now) => {
        const once = applyAll([[snapshot, now]]);
        const again = applyAll([
          [snapshot, now],
          [snapshot, now],
          [snapshot, now],
        ]);
        expect(idsOf(again.events)).toEqual(idsOf(once.events));
      }),
      { numRuns },
    );
  });
});
