import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import type { StoredEvent } from './entities.js';
import { getMetrics, resetMetrics } from './get-metrics.js';
import {
  FakeClock,
  InMemoryEventRepository,
  InMemoryLinkRepository,
  InMemoryMetricsRepository,
} from './testing/fakes.js';

// Property 4: Reinicio.
//
// `resetMetrics` replaces the metrics item with an empty one carrying
// `epoch = now`, clearing every counter at once. A subsequent `getMetrics`
// therefore reports zeroed totals/links/minutes/channels and the new epoch, and
// it never shows an event from BEFORE the new epoch, because its event floor is
// `max(epoch, now - 24h)` (Requirements 16.3, 16.7, 16.8).

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const numRuns = Number(env?.FC_NUM_RUNS ?? '100');

/** Wires the three repositories so a link carries its per-link click count. */
function makeDeps(nowMs: number): {
  links: InMemoryLinkRepository;
  metrics: InMemoryMetricsRepository;
  events: InMemoryEventRepository;
  clock: FakeClock;
} {
  const metrics = new InMemoryMetricsRepository();
  const links = new InMemoryLinkRepository((id) => metrics.clicksOf(id));
  const events = new InMemoryEventRepository();
  const clock = new FakeClock(nowMs);
  return { links, metrics, events, clock };
}

describe('resetMetrics / getMetrics (Property 4: reset)', () => {
  const nowArb = fc.integer({ min: 1_600_000_000_000, max: 2_000_000_000_000 });
  const channelArb = fc.constantFrom('qr', 'instagram', 'directo', 'otro');

  // After any sequence of clicks/visits, a reset leaves every observable counter
  // at 0 and sets epoch = now.
  // Validates: Requirements 16.7, 16.8
  test('after reset every counter is 0 and epoch equals now', async () => {
    await fc.assert(
      fc.asyncProperty(
        nowArb,
        fc.array(channelArb, { maxLength: 30 }),
        fc.array(channelArb, { maxLength: 30 }),
        async (nowMs, clickChannels, visitChannels) => {
          const deps = makeDeps(nowMs);
          const minuteSec = Math.floor(nowMs / 60000) * 60;
          for (const channel of clickChannels) {
            await deps.metrics.recordClick('link-1', channel, minuteSec);
          }
          for (const channel of visitChannels) {
            await deps.metrics.recordVisit(channel);
          }

          const resetAt = nowMs + 1000;
          deps.clock.set(resetAt);
          const epoch = await resetMetrics(deps.metrics, deps.clock);
          expect(epoch).toBe(resetAt);

          const snapshot = await getMetrics(deps);
          expect(snapshot.epoch).toBe(resetAt);
          expect(snapshot.totals).toEqual({ clicks: 0, visits: 0 });
          expect(snapshot.links).toEqual({});
          expect(snapshot.minutes).toEqual({});
          expect(snapshot.channels).toEqual({});
        },
      ),
      { numRuns },
    );
  });

  // Events stored BEFORE the new epoch are not shown after a reset; events after
  // the epoch (and within 24h) are.
  // Validates: Requirements 16.3
  test('events before the new epoch are dropped, later ones are kept', async () => {
    const nowMs = 1_700_000_000_000;
    const deps = makeDeps(nowMs);

    const beforeEvent: StoredEvent = {
      id: 'old',
      type: 'click',
      channel: 'qr',
      title: 'Old',
      ts: nowMs - 5000,
    };
    await deps.events.put(beforeEvent);

    const resetAt = nowMs;
    deps.clock.set(resetAt);
    await resetMetrics(deps.metrics, deps.clock);

    // An event strictly after the epoch, within 24h.
    const afterEvent: StoredEvent = {
      id: 'new',
      type: 'visit',
      channel: 'instagram',
      ts: resetAt + 1000,
    };
    await deps.events.put(afterEvent);
    deps.clock.set(resetAt + 2000);

    const snapshot = await getMetrics(deps);
    const ids = snapshot.events.map((e) => e.id);
    expect(ids).toContain('new');
    expect(ids).not.toContain('old');
  });

  // Resetting an already-empty state is stable: the observable snapshot stays
  // zeroed and only the epoch advances with the clock.
  // Validates: Requirements 16.7
  test('resetting an empty state only advances the epoch', async () => {
    const deps = makeDeps(1_700_000_000_000);
    await resetMetrics(deps.metrics, deps.clock);
    const first = await getMetrics(deps);

    deps.clock.set(1_700_000_050_000);
    const secondEpoch = await resetMetrics(deps.metrics, deps.clock);
    const second = await getMetrics(deps);

    expect(secondEpoch).toBe(1_700_000_050_000);
    expect(second.epoch).toBe(1_700_000_050_000);
    expect({ ...first, epoch: 0, serverTime: '' }).toEqual({
      ...second,
      epoch: 0,
      serverTime: '',
    });
  });
});
