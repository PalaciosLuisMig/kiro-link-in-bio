// fast-check generators for the Panel tests: snapshots, events and the pieces
// they are made of. Not part of the production bundle (nothing imports it).

import fc from 'fast-check';

import type { ActivityEvent, MetricsSnapshot } from '@link-in-bio/shared';

/** A fixed "now" so generated times are close to each other and windows overlap. */
export const BASE_TIME_MS = Date.UTC(2026, 10, 3, 12, 0, 0);

const MINUTE_MS = 60_000;

export const LINK_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
] as const;

export const CHANNEL_NAMES = ['qr', 'instagram', 'github', 'directo', 'otro'] as const;

const iso = (ms: number): string => new Date(ms).toISOString();

const counter = fc.integer({ min: 0, max: 2000 });

/** A time within about three hours around the base time. */
export const timeMs = fc.integer({
  min: BASE_TIME_MS - 90 * MINUTE_MS,
  max: BASE_TIME_MS + 90 * MINUTE_MS,
});

/** An event whose content is a pure function of its id, as in the real system. */
export const consistentEvent: fc.Arbitrary<ActivityEvent> = fc
  .integer({ min: 0, max: 29 })
  .map((n) => {
    const isClick = n % 2 === 0;
    return {
      id: `event-${String(n).padStart(2, '0')}`,
      type: isClick ? ('click' as const) : ('visit' as const),
      channel: CHANNEL_NAMES[n % CHANNEL_NAMES.length] as string,
      ...(isClick ? { title: `Enlace ${n % 4}` } : {}),
      // Every id has its own fixed time, 7 s apart: same id, same event.
      at: iso(BASE_TIME_MS - n * 7 * 1000),
    };
  });

/** An event whose content may disagree with another event of the same id. */
export const conflictingEvent: fc.Arbitrary<ActivityEvent> = fc
  .tuple(
    fc.integer({ min: 0, max: 9 }),
    fc.constantFrom('click' as const, 'visit' as const),
    fc.constantFrom(...CHANNEL_NAMES),
    fc.option(fc.constantFrom('A', 'B', 'C'), { nil: undefined }),
    timeMs,
  )
  .map(([n, type, channel, title, at]) => ({
    id: `event-${n}`,
    type,
    channel,
    ...(title !== undefined ? { title } : {}),
    at: iso(at),
  }));

/** The `minutes` of a snapshot: some inside the last hour, some before, some after. */
function minutesFor(serverMs: number): fc.Arbitrary<Record<string, number>> {
  return fc
    .array(fc.tuple(fc.integer({ min: -100, max: 5 }), counter), { maxLength: 12 })
    .map((entries) => {
      const nowMinute = Math.floor(serverMs / MINUTE_MS) * MINUTE_MS;
      return Object.fromEntries(
        entries.map(([offset, clicks]) => [iso(nowMinute + offset * MINUTE_MS), clicks]),
      );
    });
}

export interface SnapshotOptions {
  readonly epoch?: fc.Arbitrary<number>;
  readonly event?: fc.Arbitrary<ActivityEvent>;
}

/** A well-formed metrics snapshot, in any epoch unless one is given. */
export function snapshotArb(options: SnapshotOptions = {}): fc.Arbitrary<MetricsSnapshot> {
  const event = options.event ?? conflictingEvent;
  return timeMs.chain((serverMs) =>
    fc.record({
      epoch: options.epoch ?? fc.constantFrom(0, BASE_TIME_MS - 3_600_000, BASE_TIME_MS),
      serverTime: fc.constant(iso(serverMs)),
      totals: fc.record({ clicks: counter, visits: counter }),
      links: fc
        .subarray([...LINK_IDS])
        .chain((ids) => fc.tuple(...ids.map((id) => fc.tuple(fc.constant(id), counter))))
        .map((entries) => Object.fromEntries(entries)),
      minutes: minutesFor(serverMs),
      channels: fc
        .subarray([...CHANNEL_NAMES])
        .chain((names) =>
          fc.tuple(
            ...names.map((name) =>
              fc.tuple(fc.constant(name), fc.record({ clicks: counter, visits: counter })),
            ),
          ),
        )
        .map((entries) => Object.fromEntries(entries)),
      events: fc.array(event, { maxLength: 25 }),
    }),
  );
}

/** A snapshot whose epoch is fixed, so several of them can be merged. */
export function snapshotInEpoch(epoch: number): fc.Arbitrary<MetricsSnapshot> {
  return snapshotArb({ epoch: fc.constant(epoch) });
}

/** The browser clock when a snapshot arrives. */
export const localNowMs = timeMs;
