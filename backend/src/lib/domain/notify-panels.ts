// Pure domain use case: pushing a metrics snapshot to every open Panel.
//
// This module is pure domain logic: no AWS, no Node, no DOM imports. It takes
// its ports (`RealtimeAccessRepository`, `RealtimeNotifier`, `Logger`) and the
// `getMetrics` dependencies as injected values; the composition root of the
// `notify-panel` handler (task 11.2) wires the real adapters and the tests wire
// the in-memory doubles (`testing/fakes.ts`).
//
// The handler, not this use case, owns the 1 s invocation pause (Requirement
// 8.7). `notifyPanels` only builds the snapshot and sends it. The stream record
// content is irrelevant: a Streams event is a mere "something changed" signal,
// so this use case reads the CURRENT state and never inspects the record.
//
// Behavior (design "notifyPanels" algorithm; Requirements 8.1, 8.2, 12.6, 12.7,
// 16.5):
// 1. List the non-expired connections first. If there are none, terminate
//    WITHOUT reading metrics or waiting, so an idle demo does no work.
// 2. Build the snapshot via `getMetrics`. If `getMetrics` fails, THROW so the
//    Lambda retries once (the design's single retry).
// 3. Send the snapshot to every connection with a fixed limited concurrency.
//    A `gone` (410) result removes that connection (Requirement 12.7); any
//    other failure is logged and skipped so the rest still receive it
//    (Requirement 12.6).

import type { MetricsSnapshot } from '@link-in-bio/shared';

import { getMetrics, type GetMetricsDeps } from './get-metrics.js';
import type { Connection } from './entities.js';
import type { Logger, RealtimeAccessRepository, RealtimeNotifier } from './ports.js';

/**
 * Maximum number of connections contacted at the same time. A fixed small bound
 * keeps the fan-out predictable regardless of how many Panels are open, as the
 * design prescribes (e.g. 10).
 */
const SEND_CONCURRENCY = 10;

/** The ports `notifyPanels` needs, plus the `getMetrics` dependencies. */
export interface NotifyPanelsDeps {
  /** Lists the open connections and removes the ones that are gone. */
  readonly realtime: RealtimeAccessRepository;
  /** Pushes the snapshot to one connection; reports `gone` on a closed one. */
  readonly notifier: RealtimeNotifier;
  /** Structured logger (allowed fields only) for non-`gone` send failures. */
  readonly logger: Logger;
  /** The dependencies `getMetrics` reads the snapshot from. */
  readonly metrics: GetMetricsDeps;
}

/**
 * Pushes the current metrics snapshot to every open Panel connection
 * (Requirements 8.1, 8.2, 12.6, 12.7, 16.5).
 *
 * Lists the non-expired connections FIRST and returns immediately when there
 * are none, so no metrics are read and nothing waits on an idle demo. Otherwise
 * it builds the snapshot with {@link getMetrics} (letting a `getMetrics` failure
 * propagate so the Lambda can retry once) and sends it to all connections with
 * a fixed concurrency bound. A `gone` connection is removed; any other send
 * failure is logged and skipped, and the remaining connections still receive
 * the snapshot.
 *
 * @throws whatever `getMetrics` throws, so the Lambda retries once.
 */
export async function notifyPanels(deps: NotifyPanelsDeps): Promise<void> {
  const now = deps.metrics.clock.now();
  const connections = await deps.realtime.listConnections(now);
  if (connections.length === 0) {
    // No Panels listening: do not read metrics and do not wait.
    return;
  }

  // A `getMetrics` failure propagates so the Lambda retries once (16.5).
  const snapshot = await getMetrics(deps.metrics);

  await sendToAll(deps, connections, snapshot);
}

/**
 * Sends `snapshot` to every connection with at most {@link SEND_CONCURRENCY}
 * sends in flight. A fixed pool of workers drains a shared cursor over the
 * connection list, so the number of concurrent sends is bounded no matter how
 * many connections are open.
 */
async function sendToAll(
  deps: NotifyPanelsDeps,
  connections: readonly Connection[],
  snapshot: MetricsSnapshot,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (let index = cursor; index < connections.length; index = cursor) {
      cursor += 1;
      await sendOne(deps, connections[index]!, snapshot);
    }
  };

  const poolSize = Math.min(SEND_CONCURRENCY, connections.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
}

/**
 * Sends the snapshot to one connection and reconciles the outcome: a `gone`
 * (410) connection is removed (Requirement 12.7); any other failure is logged
 * with allowed fields only and swallowed so the rest still receive it
 * (Requirement 12.6).
 */
async function sendOne(
  deps: NotifyPanelsDeps,
  connection: Connection,
  snapshot: MetricsSnapshot,
): Promise<void> {
  try {
    const result = await deps.notifier.send(connection.connectionId, snapshot);
    if (result === 'gone') {
      await deps.realtime.removeConnection(connection.connectionId);
    }
  } catch {
    // A non-`gone` failure (e.g. a transient API error): log and continue with
    // the remaining connections. The log carries only the allowed fields.
    deps.logger.error('notify_panel_send_failed', { code: 'notify_panel_send_failed' });
  }
}
