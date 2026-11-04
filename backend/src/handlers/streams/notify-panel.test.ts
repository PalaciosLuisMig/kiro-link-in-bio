import { beforeEach, describe, expect, test } from 'vitest';

import { ENV_VARS } from '@link-in-bio/shared';

import type { NotifyPanelsDeps } from '../../lib/domain/notify-panels.js';
import type { RealtimeNotifier, SendResult } from '../../lib/domain/ports.js';
import {
  FakeClock,
  InMemoryEventRepository,
  InMemoryLinkRepository,
  InMemoryMetricsRepository,
  InMemoryRealtimeAccessRepository,
  InMemoryRealtimeNotifier,
  RecordingLogger,
} from '../../lib/domain/testing/fakes.js';

import { composeNotifyPanel } from './notify-panel-composition.js';
import { handleNotifyPanel, MIN_INVOCATION_MS } from './notify-panel-routes.js';

// Tests of the `notify-panel` Lambda logic (task 11.3): the 1 s minimum pause
// measured with a FakeClock, no waiting when nobody listens, and no pause when
// reading the metrics fails (the Lambda then retries once).
//
// Validates: Requirements 8.1, 8.2, 8.7, 12.6, 12.7, 16.5.

const NOW_MS = 1_700_000_000_000;

interface Fixture {
  readonly deps: NotifyPanelsDeps;
  readonly realtime: InMemoryRealtimeAccessRepository;
  readonly notifier: InMemoryRealtimeNotifier;
  readonly events: InMemoryEventRepository;
  readonly clock: FakeClock;
}

function fixture(notifier = new InMemoryRealtimeNotifier()): Fixture {
  const metrics = new InMemoryMetricsRepository();
  const events = new InMemoryEventRepository();
  const clock = new FakeClock(NOW_MS);
  const realtime = new InMemoryRealtimeAccessRepository();
  return {
    deps: {
      realtime,
      notifier,
      logger: new RecordingLogger(),
      metrics: {
        links: new InMemoryLinkRepository((id) => metrics.clicksOf(id)),
        metrics,
        events,
        clock,
      },
    },
    realtime,
    notifier: notifier as InMemoryRealtimeNotifier,
    events,
    clock,
  };
}

async function openConnection(realtime: InMemoryRealtimeAccessRepository): Promise<void> {
  await realtime.addConnection({ connectionId: 'conn-1', createdAt: NOW_MS });
}

describe('handleNotifyPanel', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });

  test('pads the invocation to 1 s after sending', async () => {
    await openConnection(f.realtime);

    await handleNotifyPanel(f.deps);

    expect(f.notifier.sent).toHaveLength(1);
    expect(f.clock.sleeps).toEqual([MIN_INVOCATION_MS]);
    expect(f.clock.now()).toBe(NOW_MS + MIN_INVOCATION_MS);
  });

  test('does not wait when the work already took 1 s or more', async () => {
    const slowClock = new FakeClock(NOW_MS);
    const metrics = new InMemoryMetricsRepository();
    const realtime = new InMemoryRealtimeAccessRepository();
    await openConnection(realtime);
    const notifier: RealtimeNotifier = {
      async send(): Promise<SendResult> {
        slowClock.advance(1500);
        return 'sent';
      },
    };
    await handleNotifyPanel({
      realtime,
      notifier,
      logger: new RecordingLogger(),
      metrics: {
        links: new InMemoryLinkRepository(() => 0),
        metrics,
        events: new InMemoryEventRepository(),
        clock: slowClock,
      },
    });
    expect(slowClock.sleeps).toEqual([]);
  });

  test('waits only the remaining 600 ms after 400 ms of work', async () => {
    const clock = new FakeClock(NOW_MS);
    const realtime = new InMemoryRealtimeAccessRepository();
    await openConnection(realtime);
    const notifier: RealtimeNotifier = {
      async send(): Promise<SendResult> {
        clock.advance(400);
        return 'sent';
      },
    };
    await handleNotifyPanel({
      realtime,
      notifier,
      logger: new RecordingLogger(),
      metrics: {
        links: new InMemoryLinkRepository(() => 0),
        metrics: new InMemoryMetricsRepository(),
        events: new InMemoryEventRepository(),
        clock,
      },
    });
    expect(clock.sleeps).toEqual([600]);
    expect(clock.now()).toBe(NOW_MS + 1000);
  });

  test('with no open connection it neither sends nor waits', async () => {
    await handleNotifyPanel(f.deps);

    expect(f.notifier.sent).toHaveLength(0);
    expect(f.clock.sleeps).toEqual([]);
    expect(f.clock.now()).toBe(NOW_MS);
  });

  test('ignores the stream records: it takes no event at all', () => {
    // The handler signature has no event parameter, so the content of the
    // records cannot influence what is sent (design "Notificador").
    expect(handleNotifyPanel.length).toBe(1);
  });

  test('a failing metrics read propagates and adds no pause', async () => {
    await openConnection(f.realtime);
    f.events.latest = async () => {
      throw new Error('dynamo down');
    };

    await expect(handleNotifyPanel(f.deps)).rejects.toThrow('dynamo down');

    expect(f.notifier.sent).toHaveLength(0);
    expect(f.clock.sleeps).toEqual([]);
  });

  test('a gone connection is removed and the invocation is still padded', async () => {
    await openConnection(f.realtime);
    f.notifier.markGone('conn-1');

    await handleNotifyPanel(f.deps);

    expect(await f.realtime.listConnections(NOW_MS)).toHaveLength(0);
    expect(f.clock.sleeps).toEqual([MIN_INVOCATION_MS]);
  });

  test('a failing send is logged, skipped, and the invocation still completes', async () => {
    await openConnection(f.realtime);
    f.notifier.sendFailure.armOnce();

    await expect(handleNotifyPanel(f.deps)).resolves.toBeUndefined();
    expect(f.clock.sleeps).toEqual([MIN_INVOCATION_MS]);
  });
});

describe('composeNotifyPanel', () => {
  const full = {
    [ENV_VARS.tableName]: 'LinkInBioTable',
    [ENV_VARS.wsManagementEndpoint]: 'https://abc.execute-api.us-east-1.amazonaws.com/prod',
  };

  test.each([ENV_VARS.tableName, ENV_VARS.wsManagementEndpoint])(
    'fails fast naming %s when it is missing',
    (name) => {
      expect(() => composeNotifyPanel({ ...full, [name]: undefined })).toThrow(name);
    },
  );

  test('builds the dependencies when everything is set', () => {
    const deps = composeNotifyPanel(full);
    expect(deps.notifier).toBeDefined();
    expect(deps.metrics.clock).toBeDefined();
  });
});
