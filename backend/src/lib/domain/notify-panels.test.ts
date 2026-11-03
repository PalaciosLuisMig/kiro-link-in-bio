import { describe, expect, test } from 'vitest';

import type { Connection, MetricsItem } from './entities.js';
import type { GetMetricsDeps } from './get-metrics.js';
import { notifyPanels, type NotifyPanelsDeps } from './notify-panels.js';
import type { MetricsRepository } from './ports.js';
import {
  FakeClock,
  InMemoryEventRepository,
  InMemoryLinkRepository,
  InMemoryMetricsRepository,
  InMemoryRealtimeAccessRepository,
  InMemoryRealtimeNotifier,
  RecordingLogger,
} from './testing/fakes.js';

// Task 7.4: notifyPanels.
//
// These tests use the in-memory doubles to cover the four behaviors the design
// pins down (Requirements 8.1, 8.2, 12.6, 12.7, 16.5):
// - no connections -> no metrics read and no send;
// - a `gone` (410) connection is removed;
// - a non-`gone` send failure is logged and skipped, yet the rest still receive;
// - a `getMetrics` failure propagates (throws), so the Lambda can retry once.

const NOW_MS = 1_700_000_000_000;

/**
 * A `MetricsRepository` wrapper that counts calls to `read` and can be armed to
 * throw from `read`, so a test can assert that an idle `notifyPanels` reads NO
 * metrics and that a failing `getMetrics` propagates.
 */
class CountingMetricsRepository implements MetricsRepository {
  reads = 0;
  failRead = false;

  constructor(private readonly inner: InMemoryMetricsRepository) {}

  async recordClick(linkId: string, channel: string, minuteSec: number): Promise<void> {
    await this.inner.recordClick(linkId, channel, minuteSec);
  }

  async recordVisit(channel: string): Promise<void> {
    await this.inner.recordVisit(channel);
  }

  async read(): Promise<MetricsItem> {
    this.reads += 1;
    if (this.failRead) {
      throw new Error('simulated metrics read failure');
    }
    return this.inner.read();
  }

  async reset(now: number): Promise<void> {
    await this.inner.reset(now);
  }

  async removeLinkCounter(linkId: string): Promise<void> {
    await this.inner.removeLinkCounter(linkId);
  }
}

/** Builds the full dependency set, returning the doubles the tests inspect. */
function makeDeps(nowMs = NOW_MS): {
  deps: NotifyPanelsDeps;
  realtime: InMemoryRealtimeAccessRepository;
  notifier: InMemoryRealtimeNotifier;
  logger: RecordingLogger;
  metricsCounter: CountingMetricsRepository;
  clock: FakeClock;
} {
  const inner = new InMemoryMetricsRepository();
  const metricsCounter = new CountingMetricsRepository(inner);
  const links = new InMemoryLinkRepository((id) => inner.clicksOf(id));
  const events = new InMemoryEventRepository();
  const clock = new FakeClock(nowMs);
  const realtime = new InMemoryRealtimeAccessRepository();
  const notifier = new InMemoryRealtimeNotifier();
  const logger = new RecordingLogger();

  const metrics: GetMetricsDeps = { links, metrics: metricsCounter, events, clock };
  const deps: NotifyPanelsDeps = { realtime, notifier, logger, metrics };
  return { deps, realtime, notifier, logger, metricsCounter, clock };
}

/** Seeds `count` open connections with ids `conn-1`, `conn-2`, ... */
async function seedConnections(
  realtime: InMemoryRealtimeAccessRepository,
  count: number,
  createdAt = NOW_MS,
): Promise<Connection[]> {
  const connections: Connection[] = [];
  for (let i = 1; i <= count; i += 1) {
    const connection: Connection = { connectionId: `conn-${i}`, createdAt };
    await realtime.addConnection(connection);
    connections.push(connection);
  }
  return connections;
}

describe('notifyPanels', () => {
  // With no open connections, the use case must not read metrics nor send
  // anything: it returns immediately (Requirements 8.1, 8.2, 16.5).
  test('no connections: reads no metrics and sends nothing', async () => {
    const { deps, notifier, metricsCounter } = makeDeps();

    await expect(notifyPanels(deps)).resolves.toBeUndefined();

    expect(metricsCounter.reads).toBe(0);
    expect(notifier.sent).toHaveLength(0);
  });

  // Expired connections are not listed by the repository, so an all-expired set
  // behaves exactly like having no connections.
  test('only expired connections: treated as no connections', async () => {
    const { deps, realtime, notifier, metricsCounter, clock } = makeDeps();
    // Connection created 48 h ago -> its 24 h TTL has already passed.
    await seedConnections(realtime, 2, NOW_MS - 48 * 60 * 60 * 1000);
    clock.set(NOW_MS);

    await notifyPanels(deps);

    expect(metricsCounter.reads).toBe(0);
    expect(notifier.sent).toHaveLength(0);
  });

  // Every open connection receives the snapshot once.
  test('sends the snapshot to every open connection', async () => {
    const { deps, realtime, notifier, metricsCounter } = makeDeps();
    await seedConnections(realtime, 3);

    await notifyPanels(deps);

    expect(metricsCounter.reads).toBe(1);
    expect(notifier.sent.map((s) => s.connectionId).sort()).toEqual(['conn-1', 'conn-2', 'conn-3']);
    // The payload is the absolute snapshot built by getMetrics.
    for (const { payload } of notifier.sent) {
      expect(payload.serverTime).toBe(new Date(NOW_MS).toISOString());
      expect(payload.totals).toEqual({ clicks: 0, visits: 0 });
    }
  });

  // A `gone` (410) connection is removed; the rest still receive the snapshot
  // (Requirement 12.7).
  test('removes connections that are gone (410)', async () => {
    const { deps, realtime, notifier } = makeDeps();
    await seedConnections(realtime, 3);
    notifier.markGone('conn-2');

    await notifyPanels(deps);

    // conn-2 got no payload; it was removed from the repository.
    expect(notifier.sent.map((s) => s.connectionId).sort()).toEqual(['conn-1', 'conn-3']);
    const remaining = await realtime.listConnections(NOW_MS);
    expect(remaining.map((c) => c.connectionId).sort()).toEqual(['conn-1', 'conn-3']);
  });

  // A non-`gone` send failure is logged and skipped; the other connections
  // still receive the snapshot and the connection is NOT removed (12.6).
  test('logs and skips non-gone send failures, others still receive', async () => {
    const { deps, realtime, notifier, logger } = makeDeps();
    await seedConnections(realtime, 3);
    // Fail exactly one send (the first worker's first call).
    notifier.sendFailure.armOnce();

    await notifyPanels(deps);

    // Two of the three succeeded; one failed and was logged.
    expect(notifier.sent).toHaveLength(2);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.context).toEqual({ code: 'notify_panel_send_failed' });

    // A non-gone failure does not remove the connection: all three remain.
    const remaining = await realtime.listConnections(NOW_MS);
    expect(remaining).toHaveLength(3);
  });

  // When getMetrics fails, notifyPanels throws so the Lambda retries once, but
  // only after confirming there is at least one connection (metrics ARE read).
  test('propagates a getMetrics failure (throws)', async () => {
    const { deps, realtime, notifier, metricsCounter } = makeDeps();
    await seedConnections(realtime, 2);
    metricsCounter.failRead = true;

    await expect(notifyPanels(deps)).rejects.toThrow(/metrics read failure/);

    // It attempted to read metrics (connections existed) but sent nothing.
    expect(metricsCounter.reads).toBe(1);
    expect(notifier.sent).toHaveLength(0);
  });
});
