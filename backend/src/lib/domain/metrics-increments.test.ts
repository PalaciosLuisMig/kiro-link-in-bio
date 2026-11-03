import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  buildClickIncrement,
  buildVisitIncrement,
  type CounterIncrement,
  minuteStart,
  TOTAL_CLICKS_ATTRIBUTE,
  TOTAL_VISITS_ATTRIBUTE,
} from './metrics.js';

// Property 2: Conservación de los incrementos.
//
// `buildClickIncrement`/`buildVisitIncrement` only describe WHICH metrics-item
// attributes a Click or a Visit bumps by 1. The REAL atomicity guarantee is
// provided at runtime by DynamoDB's `UpdateItem` with `ADD`, which is immune to
// lost updates under concurrency; confirming that against real DynamoDB is task
// 16. Here we only verify the DOMAIN structure of those increments: that
// applying a multiset of Click/Visit increments to an in-memory item is
// COMMUTATIVE (order does not matter) and CONSERVES every increment (no click or
// visit is lost or double-counted). The in-memory `add` below simulates one
// atomic `ADD` step so the test can reason about the shape without AWS.

// fast-check run count comes from the shared config (FC_NUM_RUNS); default 100.
// Domain code must not touch the Node `process` global directly (the ESLint
// boundary of `backend/src/lib/domain/` forbids it), so we read the env var off
// `globalThis` with a narrow local type, exactly like the `shared/` tests do.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const numRuns = Number(env?.FC_NUM_RUNS ?? '100');

/** A metrics item as a plain in-memory counter bag (attribute name -> count). */
type MetricsBag = Record<string, number>;

/**
 * Applies one increment to the in-memory item, mirroring a single atomic
 * DynamoDB `ADD`: for every attribute name in the increment, add 1 to the
 * current value (0 when absent). This is the only place the "ADD" semantics are
 * modelled; it is intentionally tiny and order-independent per attribute.
 */
function add(item: MetricsBag, increment: CounterIncrement): void {
  for (const name of Object.keys(increment)) {
    item[name] = (item[name] ?? 0) + 1;
  }
}

/** Sums the values of every attribute whose name starts with `prefix`. */
function sumWithPrefix(item: MetricsBag, prefix: string): number {
  return Object.entries(item)
    .filter(([name]) => name.startsWith(prefix))
    .reduce((total, [, value]) => total + value, 0);
}

// One operation in the arbitrary sequence: a Click (with its link, channel and
// Minute) or a Visit (with its channel). Short ids/channels/minutes keep the
// probability of collisions high, which is exactly where conservation matters.
type Op =
  | {
      readonly type: 'click';
      readonly linkId: string;
      readonly channel: string;
      readonly minuteSec: number;
    }
  | { readonly type: 'visit'; readonly channel: string };

const linkIdArb = fc.constantFrom('a', 'b', 'c', 'd');
const channelArb = fc.constantFrom('qr', 'instagram', 'tiktok', 'directo', 'otro');
// A handful of distinct Minute starts (Unix seconds, multiples of 60) so several
// clicks land on the same Minute and the per-Minute conservation is meaningful.
const minuteSecArb = fc.constantFrom(0, 60, 120, 180).map((base) => 1_700_000_000 - base);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    type: fc.constant('click' as const),
    linkId: linkIdArb,
    channel: channelArb,
    minuteSec: minuteSecArb,
  }),
  fc.record({ type: fc.constant('visit' as const), channel: channelArb }),
);

/** Builds the fresh item produced by applying `ops` in the given order. */
function applyAll(ops: readonly Op[]): MetricsBag {
  const item: MetricsBag = {};
  for (const op of ops) {
    if (op.type === 'click') {
      add(item, buildClickIncrement(op.linkId, op.channel, op.minuteSec));
    } else {
      add(item, buildVisitIncrement(op.channel));
    }
  }
  return item;
}

describe('buildClickIncrement / buildVisitIncrement (Property 2: increment conservation)', () => {
  // Commutativity of the atomic `ADD`: applying the SAME multiset of increments
  // in any order yields EXACTLY the same final item. We apply the sequence once
  // in its generated order and once in an independently shuffled order and
  // require deep equality.
  // Validates: Requirements 12.1, 12.2, 12.3, 12.5
  test('applying the same multiset in reverse order yields the same item', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
        const inOrder = applyAll(ops);

        // A genuine permutation of the very same ops (same multiset).
        const reversed = applyAll([...ops].reverse());

        expect(reversed).toEqual(inOrder);
      }),
      { numRuns },
    );
  });

  // Stronger commutativity: for ANY permutation (not just the reverse), the item
  // is identical. fast-check supplies the permutation via `shuffledSubarray` over
  // the indices so we cover arbitrary orderings, not only the reversal.
  // Validates: Requirements 12.1, 12.2, 12.3, 12.5
  test('any permutation of the sequence produces the same item', () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { minLength: 0, maxLength: 60 }).chain((ops) => {
          const indices = ops.map((_, index) => index);
          return fc.record({
            ops: fc.constant(ops),
            // A full permutation of all indices.
            order: fc.shuffledSubarray(indices, { minLength: indices.length }),
          });
        }),
        ({ ops, order }) => {
          const baseline = applyAll(ops);
          const permuted = applyAll(order.map((index) => ops[index]!));
          expect(permuted).toEqual(baseline);
        },
      ),
      { numRuns },
    );
  });

  // Conservation: every Click and every Visit is counted exactly once across all
  // the counters it touches. Nothing is lost and nothing is duplicated.
  // Validates: Requirements 2.5, 2.8, 3.2, 3.7, 12.1
  test('the final item conserves every click and visit across all counters', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 80 }), (ops) => {
        const clicks = ops.filter(
          (op): op is Extract<Op, { type: 'click' }> => op.type === 'click',
        );
        const visits = ops.filter(
          (op): op is Extract<Op, { type: 'visit' }> => op.type === 'visit',
        );
        const item = applyAll(ops);

        // Totals equal the number of clicks and visits.
        expect(item[TOTAL_CLICKS_ATTRIBUTE] ?? 0).toBe(clicks.length);
        expect(item[TOTAL_VISITS_ATTRIBUTE] ?? 0).toBe(visits.length);

        // Each partition sum reconstructs the click total (clicks are bucketed by
        // link, by channel and by Minute, each a full partition of the clicks).
        expect(sumWithPrefix(item, 'l#')).toBe(clicks.length);
        expect(sumWithPrefix(item, 'cc#')).toBe(clicks.length);
        expect(sumWithPrefix(item, 'm#')).toBe(clicks.length);

        // The per-channel visit counters partition the visits.
        expect(sumWithPrefix(item, 'cv#')).toBe(visits.length);

        // Per-bucket conservation: every individual counter equals the count of
        // operations that fall in that bucket. This is the "no click lost, none
        // duplicated" invariant at the finest granularity.
        const expectedLink: Record<string, number> = {};
        const expectedClickChannel: Record<string, number> = {};
        const expectedMinute: Record<string, number> = {};
        for (const click of clicks) {
          expectedLink[`l#${click.linkId}`] = (expectedLink[`l#${click.linkId}`] ?? 0) + 1;
          expectedClickChannel[`cc#${click.channel}`] =
            (expectedClickChannel[`cc#${click.channel}`] ?? 0) + 1;
          expectedMinute[`m#${click.minuteSec}`] =
            (expectedMinute[`m#${click.minuteSec}`] ?? 0) + 1;
        }
        const expectedVisitChannel: Record<string, number> = {};
        for (const visit of visits) {
          expectedVisitChannel[`cv#${visit.channel}`] =
            (expectedVisitChannel[`cv#${visit.channel}`] ?? 0) + 1;
        }

        for (const [name, count] of Object.entries(expectedLink)) {
          expect(item[name]).toBe(count);
        }
        for (const [name, count] of Object.entries(expectedClickChannel)) {
          expect(item[name]).toBe(count);
        }
        for (const [name, count] of Object.entries(expectedMinute)) {
          expect(item[name]).toBe(count);
        }
        for (const [name, count] of Object.entries(expectedVisitChannel)) {
          expect(item[name]).toBe(count);
        }
      }),
      { numRuns },
    );
  });

  // --- Unit cases -----------------------------------------------------------

  test('one Click yields exactly the four expected attributes, all at 1', () => {
    // Validates: Requirements 2.5, 3.2
    const increment = buildClickIncrement('link-1', 'instagram', 1_700_000_040);
    expect(increment).toEqual({
      totalClicks: 1,
      'l#link-1': 1,
      'cc#instagram': 1,
      'm#1700000040': 1,
    });
    // Exactly four attribute names, nothing extra.
    expect(Object.keys(increment)).toHaveLength(4);
  });

  test('one Visit yields exactly the two expected attributes, all at 1', () => {
    // Validates: Requirements 3.2, 3.7
    const increment = buildVisitIncrement('qr');
    expect(increment).toEqual({
      totalVisits: 1,
      'cv#qr': 1,
    });
    expect(Object.keys(increment)).toHaveLength(2);
  });

  test('clicks on the same link, channel and Minute accumulate', () => {
    // Validates: Requirements 2.8, 12.1
    const minuteSec = minuteStart(1_700_000_000_000);
    const item: MetricsBag = {};
    add(item, buildClickIncrement('x', 'tiktok', minuteSec));
    add(item, buildClickIncrement('x', 'tiktok', minuteSec));
    add(item, buildClickIncrement('x', 'tiktok', minuteSec));
    expect(item).toEqual({
      totalClicks: 3,
      'l#x': 3,
      'cc#tiktok': 3,
      [`m#${minuteSec}`]: 3,
    });
  });

  test('clicks and visits of the same channel keep clicks and visits separate', () => {
    // Validates: Requirements 2.8, 3.7 (cc# and cv# are distinct counters)
    const item: MetricsBag = {};
    add(item, buildClickIncrement('x', 'directo', 1_700_000_040));
    add(item, buildVisitIncrement('directo'));
    add(item, buildVisitIncrement('directo'));
    expect(item['cc#directo']).toBe(1);
    expect(item['cv#directo']).toBe(2);
    expect(item[TOTAL_CLICKS_ATTRIBUTE]).toBe(1);
    expect(item[TOTAL_VISITS_ATTRIBUTE]).toBe(2);
  });
});
