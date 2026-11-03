// Pure domain use cases: recording a Click and a Visit.
//
// This module is pure domain logic: no AWS, no Node, no DOM imports. Both use
// cases take their ports (`LinkRepository`, `MetricsRepository`,
// `EventRepository`, `Clock`, `IdGenerator`, `Logger`) as injected
// dependencies and never touch the AWS SDK; the composition roots wire the real
// adapters and the tests wire the in-memory doubles (`testing/fakes.ts`). File
// location follows the flat convention of the other domain modules.
//
// Privacy by construction (Requirements 11.1, 11.2): neither use case receives
// an IP, a User-Agent or a Referer; the only inputs are the linkId (click) and
// the optional raw source channel. The event TTL is computed by the adapter,
// not here.
//
// Ordering guarantees (Requirements 2.7, 9.3): the counter increment is a
// single atomic operation on the metrics repository, and the activity event is
// stored ONLY AFTER the increment succeeds. If storing the event fails, the
// counter is already recorded, so the use case logs the failure (allowed fields
// only) and still succeeds; a dropped feed entry never loses a counted click or
// visit.

import { normalizeChannel } from '@link-in-bio/shared';

import type { StoredEvent } from './entities.js';
import { NotFound } from './errors.js';
import { minuteStart } from './metrics.js';
import type {
  Clock,
  EventRepository,
  IdGenerator,
  LinkRepository,
  Logger,
  MetricsRepository,
} from './ports.js';

/**
 * Optional log context forwarded to the `Logger` on the best-effort event-store
 * branch. Only the allowed fields; never a body, headers, token or ticket.
 */
export interface ActivityLogContext {
  readonly route?: string;
  readonly requestId?: string;
}

/** The ports and inputs `registerClick` needs. */
export interface RegisterClickDeps {
  readonly links: LinkRepository;
  readonly metrics: MetricsRepository;
  readonly events: EventRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/** The ports `registerVisit` needs (no LinkRepository: a visit reads no link). */
export interface RegisterVisitDeps {
  readonly metrics: MetricsRepository;
  readonly events: EventRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/**
 * Records a Click on a link (Requirements 2.5, 2.6, 2.7, 4.2-4.4, 9.3, 11.1).
 *
 * Reads the link and rejects with {@link NotFound} when it does not exist or is
 * inactive (Requirement 2.6). Normalizes the raw channel with `normalizeChannel`
 * (Requirements 4.2-4.4). Calls `Clock.now()` EXACTLY ONCE and reuses that value
 * for both the Minute bucket (`minuteStart`) and the event `ts`, so the counter
 * and the feed entry agree on the time. Increments the four click counters with
 * a single atomic `MetricsRepository.recordClick`, and ONLY on success stores
 * the activity event with the link's CURRENT title (Requirement 9.3). A failure
 * to store the event is logged (allowed fields only) and the use case still
 * succeeds.
 *
 * @param deps injected ports.
 * @param linkId id of the clicked link.
 * @param rawChannel optional raw source channel from the request.
 * @throws NotFound when the link is missing or inactive.
 */
export async function registerClick(
  deps: RegisterClickDeps,
  linkId: string,
  rawChannel: string | undefined,
  logContext: ActivityLogContext = {},
): Promise<void> {
  const link = await deps.links.get(linkId);
  if (link === null || !link.active) {
    throw new NotFound('link not found');
  }

  const channel = normalizeChannel(rawChannel);
  const nowMs = deps.clock.now();
  const minuteSec = minuteStart(nowMs);

  await deps.metrics.recordClick(linkId, channel, minuteSec);

  const event: StoredEvent = {
    id: deps.ids.next(),
    type: 'click',
    channel,
    title: link.title,
    ts: nowMs,
  };
  await storeEventBestEffort(deps.events, deps.logger, event, logContext);
}

/**
 * Records a Visit to the public page (Requirements 3.2, 4.2-4.4, 9.3, 11.1).
 *
 * Reads no link. Normalizes the raw channel, calls `Clock.now()` EXACTLY ONCE,
 * increments the two visit counters with a single atomic
 * `MetricsRepository.recordVisit`, and ONLY on success stores a visit event
 * (with NO title: a visit has no link title). A failure to store the event is
 * logged and the use case still succeeds.
 *
 * @param deps injected ports.
 * @param rawChannel optional raw source channel from the request.
 */
export async function registerVisit(
  deps: RegisterVisitDeps,
  rawChannel: string | undefined,
  logContext: ActivityLogContext = {},
): Promise<void> {
  const channel = normalizeChannel(rawChannel);
  const nowMs = deps.clock.now();

  await deps.metrics.recordVisit(channel);

  const event: StoredEvent = {
    id: deps.ids.next(),
    type: 'visit',
    channel,
    ts: nowMs,
  };
  await storeEventBestEffort(deps.events, deps.logger, event, logContext);
}

/**
 * Stores an activity event on a best-effort basis: the counter increment has
 * already succeeded, so a failure here must not fail the use case. The failure
 * is logged with allowed fields only (Requirements 9.3, 11.2).
 */
async function storeEventBestEffort(
  events: EventRepository,
  logger: Logger,
  event: StoredEvent,
  logContext: ActivityLogContext,
): Promise<void> {
  try {
    await events.put(event);
  } catch {
    logger.error('store_event_failed', {
      code: 'store_event_failed',
      ...(logContext.route !== undefined ? { route: logContext.route } : {}),
      ...(logContext.requestId !== undefined ? { requestId: logContext.requestId } : {}),
    });
  }
}
