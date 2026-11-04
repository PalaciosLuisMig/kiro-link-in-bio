// Pure domain use cases: reading the metrics snapshot and resetting metrics.
//
// This module is pure domain logic: no AWS, no Node, no DOM imports. Both use
// cases take their ports as injected dependencies; the composition roots wire
// the real adapters and the tests wire the in-memory doubles
// (`testing/fakes.ts`).
//
// Authorization is NOT performed here: per the design, the HTTP pipeline runs
// `authorizeOwner` (task 7.1) before these use cases, and the documented error
// precedence (ServerMisconfigured 500 wins over Unauthorized 401) lives in that
// authorization step, not in `getMetrics`/`resetMetrics`.

import type { ActivityEvent, MetricsSnapshot } from '@link-in-bio/shared';

import type { StoredEvent } from './entities.js';
import { parseMetricsItem } from './metrics.js';
import type { Clock, EventRepository, LinkRepository, MetricsRepository } from './ports.js';

/** Milliseconds in 24 hours: the maximum age of an event shown in the feed. */
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

/** Number of activity-feed events included in a snapshot (newest first). */
const FEED_LIMIT = 20;

/** Digits used to zero-pad the millisecond timestamp in an event sort key. */
const EVENT_TS_DIGITS = 13;

/**
 * Builds the exclusive sort-key floor for `EventRepository.latest`.
 *
 * Events are stored with the sort key `<ts,13 digits>#<id>`. To return only the
 * events strictly NEWER than `floorMs`, the floor is `<floorMs,13 digits>#` with
 * the highest code unit appended: it compares GREATER than every real sort key
 * at `floorMs` (whose id never starts with U+FFFF) and LESS than any sort key at
 * `floorMs + 1`, so `latest` keeps exactly the events with `ts > floorMs`. This
 * matches the design: `latest` uses `sk` greater than the larger of `epoch` and
 * `now - 24h` (Requirements 7.5, 11.8, 16.3).
 */
function eventFloorSortKey(floorMs: number): string {
  const clamped = floorMs < 0 ? 0 : floorMs;
  return `${String(clamped).padStart(EVENT_TS_DIGITS, '0')}#\uffff`;
}

/** Projects a stored event onto the public {@link ActivityEvent} wire shape. */
function toActivityEvent(event: StoredEvent): ActivityEvent {
  return {
    id: event.id,
    type: event.type,
    channel: event.channel,
    at: new Date(event.ts).toISOString(),
    ...(event.title !== undefined ? { title: event.title } : {}),
  };
}

/** The ports `getMetrics` needs. */
export interface GetMetricsDeps {
  readonly links: LinkRepository;
  readonly metrics: MetricsRepository;
  readonly events: EventRepository;
  readonly clock: Clock;
}

/**
 * Builds the absolute metrics snapshot (Requirements 7.1-7.7, 11.8, 16.8).
 *
 * Reads the metrics item and turns it into counters with `parseMetricsItem`
 * (totals, per-link, per-channel and the last 60 Minutes as ISO keys), reads
 * the current existing links, and the newest `FEED_LIMIT` events of the current
 * epoch. It then:
 * - sets `serverTime` to the ISO form of `Clock.now()` so the Panel can correct
 *   its clock (Requirement 7.6);
 * - FILTERS `links` down to the links that still exist, dropping an orphan
 *   `l#<id>` counter left by a failed counter delete or a click/delete race
 *   (Requirement 6.5); totals and channels keep the historical clicks;
 * - projects the events to {@link ActivityEvent} with an ISO `at`.
 *
 * `Clock.now()` is read once and used for both the event-age floor and
 * `serverTime`. The event floor is the larger of the epoch and `now - 24h`, so
 * events from a previous epoch or older than 24 h are never shown even before
 * DynamoDB deletes them (Requirements 11.8, 16.3).
 */
export async function getMetrics(deps: GetMetricsDeps): Promise<MetricsSnapshot> {
  const nowMs = deps.clock.now();

  const [item, links] = await Promise.all([deps.metrics.read(), deps.links.list()]);
  const parsed = parseMetricsItem(item, nowMs);

  const floorMs = Math.max(parsed.epoch, nowMs - MAX_EVENT_AGE_MS);
  const storedEvents = await deps.events.latest(eventFloorSortKey(floorMs), FEED_LIMIT);

  // Keep only the per-link counters whose link still exists (Requirement 6.5).
  const existingIds = new Set(links.map((link) => link.id));
  const filteredLinks: Record<string, number> = {};
  for (const [id, clicks] of Object.entries(parsed.links)) {
    if (existingIds.has(id)) {
      filteredLinks[id] = clicks;
    }
  }

  return {
    epoch: parsed.epoch,
    serverTime: new Date(nowMs).toISOString(),
    totals: parsed.totals,
    links: filteredLinks,
    minutes: parsed.minutes,
    channels: parsed.channels,
    events: storedEvents.map(toActivityEvent),
  };
}

/**
 * Resets the metrics (Requirements 16.3, 16.7, 16.8).
 *
 * Replaces the metrics item with an empty one carrying `epoch = now`, which
 * clears every counter at once. Previous events are effectively discarded
 * because `getMetrics` reads only events with a sort key above the new epoch.
 *
 * Noted risk (Requirement 16.3): two resets within the same millisecond would
 * not produce a strictly greater epoch; this is acceptable with a single human
 * owner, as the design records.
 *
 * @returns the new epoch (Unix ms), for the `{ epoch }` reset response.
 */
export async function resetMetrics(metrics: MetricsRepository, clock: Clock): Promise<number> {
  const now = clock.now();
  await metrics.reset(now);
  return now;
}
