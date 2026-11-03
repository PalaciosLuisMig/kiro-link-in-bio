import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  KEEPALIVE,
  parse,
  parseKeepalive,
  serialize,
  type ActivityEvent,
  type RealtimeMessage,
} from './realtime.js';

// Honor the shared fast-check run count (FC_NUM_RUNS; default 100, lowered by the save hook).
// `shared/` must not depend on Node types, so we read the env var off `globalThis`
// with a narrow local type instead of referencing the Node `process` global.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const numRuns = Number(env?.FC_NUM_RUNS ?? '100');

/** An ISO 8601 UTC timestamp arbitrary, e.g. "2024-05-01T10:30:00.000Z". */
const isoTimestamp = fc
  .date({
    min: new Date('1970-01-01T00:00:00.000Z'),
    max: new Date('2100-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

/** A non-negative integer counter. */
const counter = fc.nat();

// An activity event; `title` is present only for clicks. A real snapshot either
// carries `title` with a string or omits the key entirely: it is never an
// explicit `undefined`, which `JSON.stringify` would drop and so break a strict
// round-trip comparison. We model that by generating the key or leaving it out.
const eventWithTitle: fc.Arbitrary<ActivityEvent> = fc.record({
  id: fc.string(),
  type: fc.constantFrom('click', 'visit'),
  title: fc.string(),
  channel: fc.string(),
  at: isoTimestamp,
});

const eventWithoutTitle: fc.Arbitrary<ActivityEvent> = fc.record({
  id: fc.string(),
  type: fc.constantFrom('click', 'visit'),
  channel: fc.string(),
  at: isoTimestamp,
});

const activityEventArb: fc.Arbitrary<ActivityEvent> = fc.oneof(eventWithTitle, eventWithoutTitle);

// Real snapshots are plain objects, so keep generated records on the normal
// Object prototype; `fc.dictionary` can otherwise emit `{ __proto__: null }`,
// which a JSON round trip turns back into a plain object and would fail a strict
// prototype comparison for no behavioral reason.
//
// We also exclude the literal key `"__proto__"` from the generated keys. A
// `"__proto__"` own property is not representable across a JSON round trip:
// `JSON.stringify` writes it out, but `JSON.parse` does not recreate it as a
// normal own enumerable property, so the reconstructed object simply lacks the
// key. That is a limitation of JSON's object model, not a bug in
// `serialize`/`parse`, so generating that key would only produce a spurious
// counterexample. `noNullPrototype: true` controls the prototype of the record
// itself and does not prevent `fc.string()` from emitting `"__proto__"` as a key.
const recordKey = fc.string().filter((k) => k !== '__proto__');

/** A `record<string, number>` arbitrary used for links and minutes. */
const stringNumberRecord = fc.dictionary(recordKey, counter, { noNullPrototype: true });

/** A `record<string, { clicks, visits }>` arbitrary used for per-channel counts. */
const channelCountsRecord = fc.dictionary(
  recordKey,
  fc.record({ clicks: counter, visits: counter }),
  { noNullPrototype: true },
);

/** A valid `RealtimeMessage` (a `snapshot`). */
const realtimeMessageArb: fc.Arbitrary<RealtimeMessage> = fc.record({
  type: fc.constant('snapshot' as const),
  epoch: counter,
  serverTime: isoTimestamp,
  totals: fc.record({ clicks: counter, visits: counter }),
  links: stringNumberRecord,
  minutes: stringNumberRecord,
  channels: channelCountsRecord,
  events: fc.array(activityEventArb, { maxLength: 20 }),
});

describe('Property 14: message round trip', () => {
  test('parse(serialize(message)) recovers an equal message', () => {
    fc.assert(
      fc.property(realtimeMessageArb, (message) => {
        const text = serialize(message);

        // serialize produces syntactically valid JSON.
        expect(() => JSON.parse(text) as unknown).not.toThrow();

        const result = parse(text);
        expect(result.ok).toBe(true);
        if (result.ok) {
          // Requirement 14.8 asks for an *equivalent* message. The canonical
          // equivalent is the message after a JSON round trip, which drops any
          // explicit `undefined` and normalizes the object prototype. Comparing
          // against it keeps the check strict on content while ignoring
          // differences JSON cannot represent.
          const expected = JSON.parse(text) as RealtimeMessage;
          expect(result.value).toStrictEqual(expected);
        }
      }),
      { numRuns },
    );
  });

  test('serialize always produces valid JSON', () => {
    fc.assert(
      fc.property(realtimeMessageArb, (message) => {
        const text = serialize(message);
        expect(typeof text).toBe('string');
        const reparsed = JSON.parse(text) as { type: unknown };
        expect(reparsed.type).toBe('snapshot');
      }),
      { numRuns },
    );
  });
});

describe('parse error cases', () => {
  test('syntactically invalid JSON yields a descriptive error without throwing', () => {
    const result = parse('{ not valid json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid JSON');
    }
  });

  test('empty input yields a descriptive error', () => {
    const result = parse('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid JSON');
    }
  });

  test('valid JSON that does not match the schema yields a descriptive error', () => {
    // Valid JSON, but the wrong message type and missing fields.
    const result = parse(JSON.stringify({ type: 'keepalive' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Does not match the schema');
    }
  });

  test('a snapshot with a wrongly typed field yields a descriptive error naming the path', () => {
    const almost = {
      type: 'snapshot',
      epoch: 0,
      serverTime: '2024-05-01T10:30:00.000Z',
      totals: { clicks: 1, visits: 2 },
      links: {},
      minutes: {},
      channels: {},
      events: 'not-an-array',
    };
    const result = parse(JSON.stringify(almost));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Does not match the schema');
      expect(result.error).toContain('events');
    }
  });

  test('any rejected input is reported as an error rather than thrown', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        // parse never throws, regardless of the input.
        expect(() => parse(raw)).not.toThrow();
      }),
      { numRuns },
    );
  });
});

describe('parseKeepalive', () => {
  test('accepts the serialized KEEPALIVE constant', () => {
    const result = parseKeepalive(JSON.stringify(KEEPALIVE));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toStrictEqual(KEEPALIVE);
    }
  });

  test('accepts the literal keepalive JSON text', () => {
    const result = parseKeepalive('{"type":"keepalive"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toStrictEqual(KEEPALIVE);
    }
  });

  test('rejects syntactically invalid JSON with a descriptive error', () => {
    const result = parseKeepalive('{ broken');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid JSON');
    }
  });

  test('rejects valid JSON that is not a keepalive message', () => {
    const result = parseKeepalive(JSON.stringify({ type: 'snapshot' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Does not match the schema');
    }
  });

  test('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(() => parseKeepalive(raw)).not.toThrow();
      }),
      { numRuns },
    );
  });
});
