import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  type ChannelCount,
  compareChannels,
  DIRECT_CHANNEL,
  type NormalizedChannel,
  normalizeChannel,
  OTHER_CHANNEL,
  PREDEFINED_CHANNELS,
} from './channel.js';

// fast-check run count comes from the shared config (FC_NUM_RUNS); default 100.
// `shared/` must not depend on Node types, so we read the env var off `globalThis`
// with a narrow local type instead of referencing the Node `process` global.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const numRuns = Number(env?.FC_NUM_RUNS ?? '100');

// Every value `normalizeChannel` is allowed to return.
const ALLOWED_OUTPUTS: ReadonlySet<string> = new Set<string>([
  ...PREDEFINED_CHANNELS,
  DIRECT_CHANNEL,
  OTHER_CHANNEL,
]);

function isAllowedOutput(value: NormalizedChannel): boolean {
  return ALLOWED_OUTPUTS.has(value);
}

describe('normalizeChannel', () => {
  // Property 1: normalization is idempotent and its output is always one of the
  // allowed channels, for any string/undefined/null input.
  // Validates: Requirements 4.2, 4.3, 4.4, 4.7
  test('Property 1: idempotent and output stays within the allowed domain', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), (value) => {
        const once = normalizeChannel(value);
        const twice = normalizeChannel(once);

        // Output domain: always a predefined channel, `directo` or `otro`.
        expect(isAllowedOutput(once)).toBe(true);
        // Idempotence: normalizing an already-normalized value is a no-op.
        expect(twice).toBe(once);
      }),
      { numRuns },
    );
  });

  // Also cover `null` explicitly, which the signature accepts alongside undefined.
  test('Property 1: idempotent for null input', () => {
    const once = normalizeChannel(null);
    expect(isAllowedOutput(once)).toBe(true);
    expect(normalizeChannel(once)).toBe(once);
  });

  // Unit cases spelled out by the task and Requirements 4.2-4.5.
  test('lowercases only A-Z letters of a predefined channel', () => {
    // Validates: Requirement 4.2
    expect(normalizeChannel('Instagram')).toBe('instagram');
  });

  test('keeps the special `directo` channel', () => {
    // Validates: Requirement 4.2
    expect(normalizeChannel('directo')).toBe(DIRECT_CHANNEL);
  });

  test('maps an invented channel to `otro`', () => {
    // Validates: Requirement 4.4
    expect(normalizeChannel('myspace')).toBe(OTHER_CHANNEL);
  });

  test('maps a whitespace-only (non-empty) value to `otro`', () => {
    // A value of only spaces is not empty, so it is not `directo`; no trimming
    // is applied, so it cannot match a predefined channel either.
    // Validates: Requirements 4.4, 4.5
    expect(normalizeChannel('   ')).toBe(OTHER_CHANNEL);
  });

  test('maps a non-ASCII value to `otro`', () => {
    // Validates: Requirements 4.4, 4.5
    expect(normalizeChannel('日本語')).toBe(OTHER_CHANNEL);
  });

  test('maps a value longer than 32 characters to `otro`', () => {
    // Validates: Requirement 4.4
    expect(normalizeChannel('a'.repeat(33))).toBe(OTHER_CHANNEL);
  });

  test('does not collapse the Kelvin sign onto `linkedin`', () => {
    // The Kelvin sign U+212A lowercases to `k` under `toLowerCase()`, which would
    // wrongly turn this value into `linkedin`. Restricting the transform to A-Z
    // keeps it as `otro`.
    // Validates: Requirements 4.5, 8.3
    const withKelvin = 'lin\u212Aedin';
    expect(normalizeChannel(withKelvin)).toBe(OTHER_CHANNEL);
    expect(normalizeChannel(withKelvin)).not.toBe('linkedin');
  });

  test('maps the dotted capital I (U+0130) to `otro`', () => {
    // U+0130 is outside the A-Z range, so it is left untouched and never matches
    // a predefined channel.
    // Validates: Requirement 4.5
    expect(normalizeChannel('\u0130')).toBe(OTHER_CHANNEL);
  });

  test('maps an absent or empty value to `directo`', () => {
    // Validates: Requirement 4.3
    expect(normalizeChannel(undefined)).toBe(DIRECT_CHANNEL);
    expect(normalizeChannel(null)).toBe(DIRECT_CHANNEL);
    expect(normalizeChannel('')).toBe(DIRECT_CHANNEL);
  });
});

describe('compareChannels', () => {
  // Generates channel entries with a small set of names so ties happen often.
  const channelArb: fc.Arbitrary<ChannelCount> = fc.record({
    name: fc.constantFrom('qr', 'instagram', 'otro', 'directo', 'a', 'b', 'ab', ''),
    clicks: fc.integer({ min: 0, max: 5 }),
  });

  // `Math.sign(0)` is `+0` while negating it yields `-0`; `+ 0` normalizes both
  // to `+0` so `toBe` (Object.is) does not distinguish them.
  const sign = (n: number): number => Math.sign(n) + 0;

  // Property: total order and stability. Swapping arguments flips the sign, and
  // the comparator is consistent (reflexive, antisymmetric, transitive).
  // Validates: Requirements 7.4, 8.3
  test('Property: antisymmetric (opposite signs when arguments swap)', () => {
    fc.assert(
      fc.property(channelArb, channelArb, (a, b) => {
        // `+ 0` normalizes a `-0` from the negation back to `+0`.
        expect(sign(compareChannels(a, b))).toBe(-sign(compareChannels(b, a)) + 0);
      }),
      { numRuns },
    );
  });

  test('Property: reflexive (an entry compares equal to itself)', () => {
    fc.assert(
      fc.property(channelArb, (a) => {
        expect(compareChannels(a, a)).toBe(0);
      }),
      { numRuns },
    );
  });

  test('Property: transitive ordering', () => {
    fc.assert(
      fc.property(channelArb, channelArb, channelArb, (a, b, c) => {
        const ab = sign(compareChannels(a, b));
        const bc = sign(compareChannels(b, c));
        // If a <= b and b <= c then a <= c (and the same for >=).
        if (ab <= 0 && bc <= 0) {
          expect(sign(compareChannels(a, c))).toBeLessThanOrEqual(0);
        }
        if (ab >= 0 && bc >= 0) {
          expect(sign(compareChannels(a, c))).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns },
    );
  });

  test('Property: sorting is a total, stable order (clicks desc, then name asc)', () => {
    fc.assert(
      fc.property(fc.array(channelArb, { maxLength: 20 }), (entries) => {
        const sorted = [...entries].sort(compareChannels);
        for (let i = 0; i + 1 < sorted.length; i += 1) {
          const current = sorted[i]!;
          const next = sorted[i + 1]!;
          if (current.clicks !== next.clicks) {
            // Clicks must be descending.
            expect(current.clicks).toBeGreaterThan(next.clicks);
          } else {
            // Ties are broken by name ascending, compared by UTF-16 code units.
            expect(current.name <= next.name).toBe(true);
          }
        }
      }),
      { numRuns },
    );
  });

  // Unit cases: ties resolved by name, higher clicks first.
  test('orders higher clicks first regardless of name', () => {
    // Validates: Requirement 7.4
    expect(compareChannels({ name: 'zzz', clicks: 10 }, { name: 'aaa', clicks: 3 })).toBeLessThan(
      0,
    );
    expect(
      compareChannels({ name: 'aaa', clicks: 3 }, { name: 'zzz', clicks: 10 }),
    ).toBeGreaterThan(0);
  });

  test('breaks click ties by name ascending', () => {
    // Validates: Requirements 7.4, 8.3
    expect(compareChannels({ name: 'instagram', clicks: 5 }, { name: 'tiktok', clicks: 5 })).toBe(
      -1,
    );
    expect(compareChannels({ name: 'tiktok', clicks: 5 }, { name: 'instagram', clicks: 5 })).toBe(
      1,
    );
  });

  test('returns 0 for equal clicks and equal names', () => {
    expect(compareChannels({ name: 'x', clicks: 2 }, { name: 'x', clicks: 2 })).toBe(0);
  });

  test('compares names by UTF-16 code units, not by locale', () => {
    // Uppercase 'Z' (0x5A) sorts before lowercase 'a' (0x61) by code unit, which
    // is the opposite of a typical locale collation. This documents the chosen
    // ordering and guards against reintroducing `localeCompare`.
    // Validates: Requirement 8.3
    expect(compareChannels({ name: 'Z', clicks: 1 }, { name: 'a', clicks: 1 })).toBe(-1);
  });
});
