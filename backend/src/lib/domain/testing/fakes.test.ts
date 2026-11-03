import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import type { LogContext, Logger } from '../ports.js';
import {
  DeterministicRandomSource,
  eventSortKey,
  FailureSwitch,
  FakeClock,
  InMemoryEventRepository,
  InMemoryLinkRepository,
  InMemoryMetricsRepository,
  InMemoryRealtimeAccessRepository,
  InMemoryRealtimeNotifier,
  RecordingLogger,
  SequentialIdGenerator,
  TTL_SECONDS,
  ttlFromMs,
} from './fakes.js';
import { runRepositoryContract, type ContractRepositories } from './repository-contract.js';

// fast-check run count comes from the shared config (FC_NUM_RUNS); default 100.
// Domain code must not touch the Node `process` global directly (the ESLint
// boundary of `backend/src/lib/domain/` forbids it), so we read it off
// `globalThis`, exactly like the other domain tests do.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const numRuns = Number(env?.FC_NUM_RUNS ?? '100');

// --- Contract battery over the in-memory doubles ----------------------------
//
// This is the whole point of task 4's battery: validate the doubles against the
// same contract the real adapters will face in task 9. The factory wires the
// link double to read per-link counts from the metrics double, mirroring how
// the DynamoDB adapter joins the `LINKS` item and the `l#<id>` counter.

function makeDoubles(): ContractRepositories {
  const metrics = new InMemoryMetricsRepository();
  const links = new InMemoryLinkRepository((id) => metrics.clicksOf(id));
  const events = new InMemoryEventRepository();
  const access = new InMemoryRealtimeAccessRepository();
  return { links, metrics, events, access };
}

runRepositoryContract('in-memory doubles', makeDoubles);

// --- Event TTL math ---------------------------------------------------------

describe('event TTL (ts/1000 + 86400)', () => {
  test('the double computes the 24 h TTL the design prescribes', async () => {
    const events = new InMemoryEventRepository();
    const ts = 1_700_000_123_456;
    await events.put({ id: 'e1', type: 'click', channel: 'qr', title: 'T', ts });

    expect(events.ttlOf('e1')).toBe(Math.floor(ts / 1000) + TTL_SECONDS);
    expect(ttlFromMs(ts)).toBe(Math.floor(ts / 1000) + 86_400);
  });

  test('ttlFromMs floors to whole seconds before adding 24 h', () => {
    // Validates: the ms -> Unix-seconds conversion truncates (never rounds up).
    expect(ttlFromMs(1_999)).toBe(1 + 86_400); // floor(1999/1000) = 1
    expect(ttlFromMs(999)).toBe(0 + 86_400); // floor(999/1000) = 0
    expect(ttlFromMs(2_000)).toBe(2 + 86_400); // floor(2000/1000) = 2
  });
});

// --- One-time ticket consumption (atomicity) --------------------------------

describe('one-time ticket consumption', () => {
  // Property: across any interleaving of consume attempts for the same ticket,
  // it succeeds AT MOST once. A fresh, unexpired ticket is consumed by exactly
  // one of N concurrent attempts; an expired or unknown ticket by none.
  // Validates: Requirements 5.7, 5.16
  test('a ticket is accepted at most once under concurrent attempts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }), // number of concurrent attempts
        fc.boolean(), // whether the ticket is still valid at consume time
        async (attempts, valid) => {
          const access = new InMemoryRealtimeAccessRepository();
          const now = 1_700_000_000_000;
          const expiresAt = now + 60_000;
          await access.storeTicket('h', expiresAt);

          const consumeAt = valid ? now + 1000 : expiresAt + 1;
          const results = await Promise.all(
            Array.from({ length: attempts }, () => access.consumeTicket('h', consumeAt)),
          );

          const successes = results.filter((r) => r).length;
          expect(successes).toBe(valid ? 1 : 0);
          // The ticket is gone afterwards either way.
          expect(access.hasTicket('h')).toBe(false);
        },
      ),
      { numRuns },
    );
  });

  test('exactly at the 60 s boundary the ticket is rejected', async () => {
    const access = new InMemoryRealtimeAccessRepository();
    const expiresAt = 1_700_000_060_000;
    await access.storeTicket('edge', expiresAt);
    expect(await access.consumeTicket('edge', expiresAt)).toBe(false);
  });
});

// --- Failure injection ------------------------------------------------------

describe('failure injection', () => {
  test('EventRepository.put can be armed to fail once, then recover', async () => {
    const events = new InMemoryEventRepository();
    events.putFailure.armOnce();
    await expect(
      events.put({ id: 'e1', type: 'click', channel: 'qr', ts: 1_700_000_000_000 }),
    ).rejects.toThrow(/event put/);
    // The next call succeeds: a single armed failure was consumed.
    await events.put({ id: 'e2', type: 'click', channel: 'qr', ts: 1_700_000_000_000 });
    expect(events.size).toBe(1);
  });

  test('MetricsRepository.removeLinkCounter can be armed to fail', async () => {
    const metrics = new InMemoryMetricsRepository();
    await metrics.recordClick('x', 'qr', 60);
    metrics.removeCounterFailure.arm();
    await expect(metrics.removeLinkCounter('x')).rejects.toThrow(/removeLinkCounter/);
    // The counter is still there because the delete failed.
    expect((await metrics.read())['l#x']).toBe(1);
  });

  test('RealtimeNotifier.send can be armed to fail and can report gone', async () => {
    const notifier = new InMemoryRealtimeNotifier();
    const payload = {
      epoch: 0,
      serverTime: new Date(0).toISOString(),
      totals: { clicks: 0, visits: 0 },
      links: {},
      minutes: {},
      channels: {},
      events: [],
    };

    notifier.sendFailure.armOnce();
    await expect(notifier.send('c1', payload)).rejects.toThrow(/notifier send/);

    // gone path: a marked connection reports 'gone' and is not recorded as sent.
    notifier.markGone('c2');
    expect(await notifier.send('c2', payload)).toBe('gone');

    // normal path.
    expect(await notifier.send('c3', payload)).toBe('sent');
    expect(notifier.sent.map((s) => s.connectionId)).toEqual(['c3']);
  });

  test('FailureSwitch arms once, arms forever, and disarms', () => {
    const switchOnce = new FailureSwitch();
    switchOnce.armOnce();
    expect(switchOnce.shouldFail()).toBe(true);
    expect(switchOnce.shouldFail()).toBe(false);

    const switchForever = new FailureSwitch();
    switchForever.arm();
    expect(switchForever.shouldFail()).toBe(true);
    expect(switchForever.shouldFail()).toBe(true);
    switchForever.disarm();
    expect(switchForever.shouldFail()).toBe(false);
  });
});

// --- Determinism of Clock, IdGenerator and RandomSource ---------------------

describe('deterministic infrastructure doubles', () => {
  test('FakeClock reports a fixed now and advances on set/advance/sleep', async () => {
    const clock = new FakeClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    clock.set(42);
    expect(clock.now()).toBe(42);

    await clock.sleep(10);
    // sleep records the duration and advances time without waiting for real time.
    expect(clock.sleeps).toEqual([10]);
    expect(clock.now()).toBe(52);
  });

  test('FakeClock.sleep resolves promptly (does not wait real time)', async () => {
    const clock = new FakeClock(0);
    const start = Date.now();
    await clock.sleep(10_000); // 10 s of "virtual" time
    // Real elapsed time must be tiny; a generous bound avoids flakiness.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test('SequentialIdGenerator yields predictable, unique ids', () => {
    const ids = new SequentialIdGenerator('link');
    expect([ids.next(), ids.next(), ids.next()]).toEqual(['link-1', 'link-2', 'link-3']);
  });

  test('DeterministicRandomSource yields the same bytes for the same seed', () => {
    const a = new DeterministicRandomSource(0);
    const b = new DeterministicRandomSource(0);
    const bytesA = a.bytes(32);
    const bytesB = b.bytes(32);
    expect([...bytesA]).toEqual([...bytesB]);
    expect(bytesA).toHaveLength(32);
    // First bytes follow the 0,1,2,... seed sequence.
    expect([...bytesA.slice(0, 4)]).toEqual([0, 1, 2, 3]);
  });

  test('eventSortKey zero-pads to 13 digits and orders chronologically', () => {
    const early = eventSortKey(1_700_000_000_000, 'a');
    const late = eventSortKey(1_700_000_000_001, 'a');
    expect(early < late).toBe(true);
    expect(early.split('#')[0]).toHaveLength(13);
  });
});

// --- Logger type safety (compile-time guard) --------------------------------

describe('Logger context is a closed type', () => {
  test('allowed fields compile; forbidden fields do not (ts-expect-error)', () => {
    const logger: Logger = new RecordingLogger();

    // Allowed: exactly the three permitted fields.
    const allowed: LogContext = {
      code: 'server_error',
      route: '/api/clicks',
      requestId: 'req-123',
    };
    logger.info('handled request', allowed);
    logger.error('increment failed', { code: 'server_error' });

    // The generic `OnlyLogContext<T>` guard maps every property that is not in
    // LogContext to `never`, so a body, headers, the token, or the ticket
    // CANNOT be logged. Each line below must fail to type-check; the
    // expect-error directives assert exactly that at compile time.

    // @ts-expect-error token is not an allowed log field
    logger.info('leak', { token: 'secret-owner-token' });
    // @ts-expect-error body is not an allowed log field
    logger.info('leak', { body: '{"linkId":"x"}' });
    // @ts-expect-error headers are not an allowed log field
    logger.error('leak', { headers: { authorization: 'Bearer x' } });
    // @ts-expect-error ticket is not an allowed log field
    logger.error('leak', { ticket: 'abc' });

    // The recording logger still captured the allowed calls above.
    const recorder = logger as RecordingLogger;
    expect(recorder.infos.length).toBeGreaterThanOrEqual(1);
    expect(recorder.errors.length).toBeGreaterThanOrEqual(1);
  });
});
