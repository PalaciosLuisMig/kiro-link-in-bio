// Logic of the `notify-panel` Lambda, triggered by the DynamoDB stream.
//
// The stream records are only a wake-up signal: their content is ignored and
// `notifyPanels` reads the current metrics itself (design "Notificador"). After
// sending, the invocation waits until 1 s has passed since it started. A shard
// is processed sequentially (`ParallelizationFactor` 1), so that pause
// guarantees at least 1 s between two sends (Requirement 8.7) while the stream
// accumulates the signals that the next invocation answers with one snapshot.

import { notifyPanels, type NotifyPanelsDeps } from '../../lib/domain/notify-panels.js';

/** Minimum time between the start of an invocation and its end when it sent. */
export const MIN_INVOCATION_MS = 1000;

/**
 * Notifies every open Panel and pads the invocation to {@link MIN_INVOCATION_MS}.
 *
 * With no open connection it returns at once: no metrics are read and nothing
 * waits. A `getMetrics` failure propagates, so the Lambda retries once (16.5)
 * and no pause is added to a failed attempt.
 */
export async function handleNotifyPanel(deps: NotifyPanelsDeps): Promise<void> {
  const clock = deps.metrics.clock;
  const startedAt = clock.now();

  const sent = await notifyPanels(deps);
  if (!sent) {
    return;
  }

  const remaining = MIN_INVOCATION_MS - (clock.now() - startedAt);
  if (remaining > 0) {
    await clock.sleep(remaining);
  }
}
