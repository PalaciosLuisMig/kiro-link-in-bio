import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  buildClickIncrement,
  buildVisitIncrement,
  EPOCH_ATTRIBUTE,
  lastMinutes,
  minuteStart,
  parseMetricsItem,
  TOTAL_CLICKS_ATTRIBUTE,
  TOTAL_VISITS_ATTRIBUTE,
} from './metrics.js';

// fast-check run count comes from the shared config (FC_NUM_RUNS); default 100.
// Domain code must not depend on the Node `process` global directly (the ESLint
// boundary of `backend/src/lib/domain/` forbids it), so we read the env var off
// `globalThis` with a narrow local type, exactly like the `shared/` tests do.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const numRuns = Number(env?.FC_NUM_RUNS ?? '100');

const MS_PER_SECOND = 1000;

// ISO string for a Minute start expressed in Unix seconds, matching the
// conversion `parseMetricsItem` performs (`new Date(sec * 1000).toISOString()`).
function isoFromMinuteSec(minuteSec: number): string {
  return new Date(minuteSec * MS_PER_SECOND).toISOString();
}

describe('parseMetricsItem', () => {
  // A millisecond timestamp far enough from the Unix epoch that the 60-Minute
  // window never reaches negative seconds. Years ~2001..~2065.
  const nowMsArb = fc.integer({ min: 1_000_000_000_000, max: 3_000_000_000_000 });

  // A single metrics counter value as it may appear in the stored item: a finite
  // non-negative number. (`readCounter` treats anything else as 0; that path is
  // exercised separately in the "garbage values" property and the unit cases.)
  const counterArb = fc.integer({ min: 0, max: 1_000_000 });

  // Short link ids and channel names so collisions and ties happen often.
  const linkIdArb = fc.string({ minLength: 1, maxLength: 6 });
  const channelArb = fc.constantFrom('qr', 'instagram', 'tiktok', 'directo', 'otro');

  // Property 3 (part 1): for ANY metrics item and ANY time, parsing never throws
  // and yields a well-formed ParsedMetrics. Unknown attributes are ignored, the
  // emitted Minute keys are exactly the stored `m#<sec>` whose seconds fall in
  // `lastMinutes(nowMs, 60)` (as ISO 8601), totals default to 0, and the per-link
  // and per-channel counters are preserved.
  // Validates: Requirements 7.2, 7.3
  test('Property 3: never throws and keeps totals, links, channels; windows minutes; ignores junk', () => {
    // An entry describing one attribute to place in the item, tagged by kind so
    // the test can predict the expected output without reimplementing the parser.
    const attributeArb = fc.oneof(
      // Per-link click counter: l#<id>
      fc.record({ kind: fc.constant('link'), id: linkIdArb, value: counterArb }),
      // Per-channel click counter: cc#<channel>
      fc.record({ kind: fc.constant('channelClicks'), channel: channelArb, value: counterArb }),
      // Per-channel visit counter: cv#<channel>
      fc.record({ kind: fc.constant('channelVisits'), channel: channelArb, value: counterArb }),
      // Totals.
      fc.record({ kind: fc.constant('totalClicks'), value: counterArb }),
      fc.record({ kind: fc.constant('totalVisits'), value: counterArb }),
      fc.record({ kind: fc.constant('epoch'), value: counterArb }),
      // Junk attributes that must be ignored entirely.
      fc.record({
        kind: fc.constant('junk'),
        key: fc.constantFrom('pk', 'sk', 'ttl', 'type', 'owner', '_meta', 'random-key'),
        value: fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
      }),
    );

    // A Minute offset within the 60-Minute window (0 = current Minute) and one
    // outside it (too old or in the future), so both branches are exercised.
    const insideOffsetArb = fc.integer({ min: 0, max: 59 });
    const outsideOffsetArb = fc.oneof(
      fc.integer({ min: 60, max: 5000 }), // older than the window
      fc.integer({ min: -5000, max: -1 }), // in the future
    );

    fc.assert(
      fc.property(
        nowMsArb,
        fc.array(attributeArb, { maxLength: 30 }),
        fc.array(insideOffsetArb, { maxLength: 10 }),
        fc.array(outsideOffsetArb, { maxLength: 10 }),
        (nowMs, attributes, insideOffsets, outsideOffsets) => {
          const windowMinutes = lastMinutes(nowMs, 60);
          const currentMinute = minuteStart(nowMs);
          const minuteSecond = 60;

          const item: Record<string, unknown> = {};

          // Expected values, built straight from the generated data.
          const expectedLinks: Record<string, number> = {};
          const expectedChannels: Record<string, { clicks: number; visits: number }> = {};
          const expectedMinutes: Record<string, number> = {};
          let expectedTotalClicks = 0;
          let expectedTotalVisits = 0;
          let expectedEpoch = 0;

          const ensureChannel = (name: string): { clicks: number; visits: number } => {
            const existing = expectedChannels[name];
            if (existing !== undefined) {
              return existing;
            }
            const created = { clicks: 0, visits: 0 };
            expectedChannels[name] = created;
            return created;
          };

          for (const attr of attributes) {
            switch (attr.kind) {
              case 'link':
                item[`l#${attr.id}`] = attr.value;
                expectedLinks[attr.id] = attr.value;
                break;
              case 'channelClicks':
                item[`cc#${attr.channel}`] = attr.value;
                ensureChannel(attr.channel).clicks = attr.value;
                break;
              case 'channelVisits':
                item[`cv#${attr.channel}`] = attr.value;
                ensureChannel(attr.channel).visits = attr.value;
                break;
              case 'totalClicks':
                item[TOTAL_CLICKS_ATTRIBUTE] = attr.value;
                expectedTotalClicks = attr.value;
                break;
              case 'totalVisits':
                item[TOTAL_VISITS_ATTRIBUTE] = attr.value;
                expectedTotalVisits = attr.value;
                break;
              case 'epoch':
                item[EPOCH_ATTRIBUTE] = attr.value;
                expectedEpoch = attr.value;
                break;
              case 'junk':
                // Junk must never influence the output; set only if it does not
                // collide with a real attribute name (the generated keys never do).
                item[attr.key] = attr.value;
                break;
            }
          }

          // Minutes inside the window: must appear in the output, as ISO keys.
          for (const offset of insideOffsets) {
            const minuteSec = currentMinute - offset * minuteSecond;
            item[`m#${minuteSec}`] = 7;
            expectedMinutes[isoFromMinuteSec(minuteSec)] = 7;
          }
          // Minutes outside the window: must be dropped entirely.
          for (const offset of outsideOffsets) {
            const minuteSec = currentMinute - offset * minuteSecond;
            item[`m#${minuteSec}`] = 99;
          }

          const result = parseMetricsItem(item, nowMs);

          // Totals and epoch.
          expect(result.totals).toEqual({
            clicks: expectedTotalClicks,
            visits: expectedTotalVisits,
          });
          expect(result.epoch).toBe(expectedEpoch);

          // Per-link and per-channel counters are preserved exactly.
          expect(result.links).toEqual(expectedLinks);
          expect(result.channels).toEqual(expectedChannels);

          // Minutes: only those inside the window, keyed by ISO 8601.
          expect(result.minutes).toEqual(expectedMinutes);

          // Every emitted Minute key is a valid ISO string whose Minute-second
          // lies within `lastMinutes(nowMs, 60)`.
          const windowSet = new Set(windowMinutes);
          for (const isoKey of Object.keys(result.minutes)) {
            const parsedMs = Date.parse(isoKey);
            expect(Number.isNaN(parsedMs)).toBe(false);
            expect(new Date(parsedMs).toISOString()).toBe(isoKey);
            expect(windowSet.has(parsedMs / MS_PER_SECOND)).toBe(true);
          }

          // Unknown attributes never leak into the output. The only valid output
          // keys are the four known records; junk keys like `pk`/`sk`/`ttl`
          // cannot appear because they are not link ids, channels, or minutes.
          expect('pk' in result.links).toBe(false);
          expect('sk' in result.links).toBe(false);
          expect('ttl' in result.links).toBe(false);
        },
      ),
      { numRuns },
    );
  });

  // Property 3 (part 2 / Requirement 7.7): an item built ONLY from increments is
  // internally consistent, so the per-channel click sum equals the click total
  // and the per-channel visit sum equals the visit total.
  // Validates: Requirement 7.7
  test('Property 3: for an increment-only item, channel sums equal the totals', () => {
    const clickArb = fc.record({ linkId: linkIdArb, channel: channelArb });
    const visitArb = fc.record({ channel: channelArb });

    fc.assert(
      fc.property(
        nowMsArb,
        fc.array(clickArb, { maxLength: 40 }),
        fc.array(visitArb, { maxLength: 40 }),
        (nowMs, clicks, visits) => {
          // Build the item by applying every increment with an in-memory `ADD`,
          // exactly as the atomic DynamoDB update would. Every Click uses the
          // current Minute so all click minutes stay inside the window.
          const item: Record<string, number> = {};
          const add = (increment: Readonly<Record<string, 1>>): void => {
            for (const name of Object.keys(increment)) {
              item[name] = (item[name] ?? 0) + 1;
            }
          };

          const currentMinute = minuteStart(nowMs);
          for (const click of clicks) {
            add(buildClickIncrement(click.linkId, click.channel, currentMinute));
          }
          for (const visit of visits) {
            add(buildVisitIncrement(visit.channel));
          }

          const result = parseMetricsItem(item, nowMs);

          // The invariant of Requirement 7.7: because every Click bumps both
          // `totalClicks` and a `cc#` counter (and every Visit both `totalVisits`
          // and a `cv#` counter) in the same atomic increment, the channel sums
          // reconstruct the totals exactly.
          const channelClickSum = Object.values(result.channels).reduce(
            (sum, c) => sum + c.clicks,
            0,
          );
          const channelVisitSum = Object.values(result.channels).reduce(
            (sum, c) => sum + c.visits,
            0,
          );

          expect(result.totals.clicks).toBe(clicks.length);
          expect(result.totals.visits).toBe(visits.length);
          expect(channelClickSum).toBe(result.totals.clicks);
          expect(channelVisitSum).toBe(result.totals.visits);

          // The per-link sum equals the click total too, since each Click bumps
          // exactly one `l#<id>` counter and no link was removed.
          const linkSum = Object.values(result.links).reduce((sum, n) => sum + n, 0);
          expect(linkSum).toBe(result.totals.clicks);

          // All click minutes land on the current Minute, inside the window.
          if (clicks.length > 0) {
            expect(result.minutes).toEqual({ [isoFromMinuteSec(currentMinute)]: clicks.length });
          } else {
            expect(result.minutes).toEqual({});
          }
        },
      ),
      { numRuns },
    );
  });

  // --- Unit cases -----------------------------------------------------------

  test('returns zeroed totals and empty records for an empty item', () => {
    // Validates: Requirement 7.2
    const result = parseMetricsItem({}, 1_700_000_000_000);
    expect(result).toEqual({
      epoch: 0,
      totals: { clicks: 0, visits: 0 },
      links: {},
      minutes: {},
      channels: {},
    });
  });

  test('defaults epoch to 0 when the attribute is absent', () => {
    // Validates: Requirement 7.2 (epoch missing -> 0)
    const result = parseMetricsItem({ totalClicks: 3 }, 1_700_000_000_000);
    expect(result.epoch).toBe(0);
  });

  test('keeps the epoch when present', () => {
    const result = parseMetricsItem({ epoch: 1_699_000_000_000 }, 1_700_000_000_000);
    expect(result.epoch).toBe(1_699_000_000_000);
  });

  test('ignores unknown attributes (pk, sk, ttl, random keys)', () => {
    // Validates: Requirement 7.2 (unknown attributes are ignored)
    const result = parseMetricsItem(
      {
        pk: 'METRICS',
        sk: 'CURRENT',
        ttl: 123456,
        somethingElse: { nested: true },
        totalClicks: 5,
      },
      1_700_000_000_000,
    );
    expect(result.links).toEqual({});
    expect(result.channels).toEqual({});
    expect(result.minutes).toEqual({});
    expect(result.totals).toEqual({ clicks: 5, visits: 0 });
  });

  test('treats non-numeric and non-finite counter values as 0', () => {
    // Validates: Requirement 7.2 (malformed values default to 0)
    const result = parseMetricsItem(
      {
        totalClicks: 'not-a-number',
        totalVisits: Number.NaN,
        'l#abc': Number.POSITIVE_INFINITY,
        'cc#qr': null,
        epoch: 'nope',
      },
      1_700_000_000_000,
    );
    expect(result.totals).toEqual({ clicks: 0, visits: 0 });
    expect(result.epoch).toBe(0);
    expect(result.links).toEqual({ abc: 0 });
    expect(result.channels).toEqual({ qr: { clicks: 0, visits: 0 } });
  });

  test('merges cc# and cv# of the same channel into one entry', () => {
    // Validates: Requirement 7.7 (per-channel clicks and visits in one record)
    const result = parseMetricsItem({ 'cc#instagram': 4, 'cv#instagram': 2 }, 1_700_000_000_000);
    expect(result.channels).toEqual({ instagram: { clicks: 4, visits: 2 } });
  });

  test('emits per-minute clicks only within the last 60 Minutes, keyed by ISO', () => {
    // Validates: Requirement 7.3
    const nowMs = 1_700_000_000_000;
    const current = minuteStart(nowMs); // seconds
    const inWindowOld = current - 59 * 60; // oldest Minute still inside the window
    const justOutside = current - 60 * 60; // one Minute too old
    const future = current + 60; // a Minute after now

    const result = parseMetricsItem(
      {
        [`m#${current}`]: 10,
        [`m#${inWindowOld}`]: 3,
        [`m#${justOutside}`]: 100,
        [`m#${future}`]: 100,
      },
      nowMs,
    );

    expect(result.minutes).toEqual({
      [isoFromMinuteSec(current)]: 10,
      [isoFromMinuteSec(inWindowOld)]: 3,
    });
  });

  test('ignores a non-integer minute key', () => {
    // A malformed `m#` suffix that is not an integer must be dropped, not thrown.
    const nowMs = 1_700_000_000_000;
    const result = parseMetricsItem({ 'm#not-a-number': 5, 'm#12.5': 5 }, nowMs);
    expect(result.minutes).toEqual({});
  });

  test('a Minute key at the exact window edge is included', () => {
    // The oldest Minute returned by `lastMinutes(nowMs, 60)` must be kept.
    const nowMs = 1_700_000_000_000;
    const edge = lastMinutes(nowMs, 60)[0]!;
    const result = parseMetricsItem({ [`m#${edge}`]: 1 }, nowMs);
    expect(result.minutes).toEqual({ [isoFromMinuteSec(edge)]: 1 });
  });
});
