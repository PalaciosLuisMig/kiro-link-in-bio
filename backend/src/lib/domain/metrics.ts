// Pure domain helpers for the metrics item: minute math and the attribute
// names a Click or a Visit must atomically increment.
//
// This module is pure domain logic: no AWS, no Node, no DOM imports. The
// DynamoDB adapter (task 9) turns the attribute names returned here into an
// `ADD` update expression; this module never builds that expression itself.
//
// Minute-key convention (per the design): minutes are Unix SECONDS both in
// DynamoDB (the `m#<minuteSec>` attribute) and in the Panel state. ISO 8601 is
// used ONLY in the `MetricsSnapshot`. The seconds->ISO conversion lives in
// `parseMetricsItem` (task 3.2) and ISO->seconds in `applySnapshot` (task 15.1).
// Therefore every value here is in Unix seconds; this module never emits ISO,
// except `parseMetricsItem` below, which converts the Minute keys to ISO for the
// `MetricsSnapshot` exactly as the design prescribes.

import type { MetricsSnapshot } from '@link-in-bio/shared';

/** Number of seconds in one Minute (a 60-second interval aligned to UTC). */
const SECONDS_PER_MINUTE = 60;

/** Milliseconds in one Minute, used to truncate a millisecond timestamp. */
const MS_PER_MINUTE = 60_000;

/** Attribute name holding the total click counter. */
export const TOTAL_CLICKS_ATTRIBUTE = 'totalClicks';

/** Attribute name holding the total visit counter. */
export const TOTAL_VISITS_ATTRIBUTE = 'totalVisits';

/**
 * Returns the start of the UTC Minute that contains `tsMs`, in Unix SECONDS.
 *
 * The timestamp is truncated down to the minute boundary: for any millisecond
 * within a given Minute the result is the same, and it is always a multiple of
 * 60. `Math.floor` is used so timestamps before the Unix epoch (negative) still
 * truncate toward the earlier boundary rather than toward zero.
 *
 * @param tsMs Unix timestamp in milliseconds.
 * @returns Unix timestamp in seconds of the Minute start.
 */
export function minuteStart(tsMs: number): number {
  return Math.floor(tsMs / MS_PER_MINUTE) * SECONDS_PER_MINUTE;
}

/**
 * Returns the starts (in Unix seconds) of the last `count` Minutes, including
 * the Minute that contains `nowMs`.
 *
 * Order is ASCENDING (oldest first, current Minute last). This matches how the
 * Panel's Gráfica_Por_Minuto is consumed: the chart shows the consecutive
 * Minutes "con el Minuto actual en el extremo final" (Requirement 7.3), so the
 * array reads naturally left-to-right from oldest to newest. The values are
 * contiguous, each 60 seconds after the previous one.
 *
 * The typical call is `lastMinutes(nowMs, 60)`. A non-positive `count` yields an
 * empty array.
 *
 * @param nowMs Current Unix timestamp in milliseconds.
 * @param count Number of Minutes to return, ending at the current Minute.
 * @returns Ascending array of Minute starts in Unix seconds.
 */
export function lastMinutes(nowMs: number, count: number): number[] {
  if (count <= 0) {
    return [];
  }

  const currentMinute = minuteStart(nowMs);
  const earliestMinute = currentMinute - (count - 1) * SECONDS_PER_MINUTE;

  const minutes: number[] = [];
  for (let minute = earliestMinute; minute <= currentMinute; minute += SECONDS_PER_MINUTE) {
    minutes.push(minute);
  }
  return minutes;
}

/**
 * Domain representation of an atomic counter increment: the set of metrics-item
 * attribute names that must be incremented by 1 with an atomic `ADD`.
 *
 * It is a map of attribute name -> 1 so the adapter has both the names (keys)
 * and the increment amount (values) without duplicating any string literal.
 */
export type CounterIncrement = Readonly<Record<string, 1>>;

/**
 * Builds the attribute names to increment for one Click.
 *
 * A Click adds 1 to four counters, all in the same metrics item:
 * `totalClicks`, `l#<linkId>` (per link), `cc#<channel>` (per source channel)
 * and `m#<minuteSec>` (per UTC Minute).
 *
 * `channel` is assumed to be already normalized by `normalizeChannel`, and
 * `minuteSec` is a Minute start in Unix seconds (from `minuteStart`). This
 * returns only the domain attribute names; the DynamoDB `ADD` expression is
 * built by the adapter (task 9).
 *
 * @param linkId Identifier of the clicked link.
 * @param channel Already-normalized source channel.
 * @param minuteSec Minute start in Unix seconds.
 */
export function buildClickIncrement(
  linkId: string,
  channel: string,
  minuteSec: number,
): CounterIncrement {
  return {
    [TOTAL_CLICKS_ATTRIBUTE]: 1,
    [`l#${linkId}`]: 1,
    [`cc#${channel}`]: 1,
    [`m#${minuteSec}`]: 1,
  };
}

/**
 * Builds the attribute names to increment for one Visit.
 *
 * A Visit adds 1 to two counters in the metrics item: `totalVisits` and
 * `cv#<channel>` (per source channel). `channel` is assumed to be already
 * normalized by `normalizeChannel`.
 *
 * @param channel Already-normalized source channel.
 */
export function buildVisitIncrement(channel: string): CounterIncrement {
  return {
    [TOTAL_VISITS_ATTRIBUTE]: 1,
    [`cv#${channel}`]: 1,
  };
}

// --- Reading the metrics item -------------------------------------------------
//
// `parseMetricsItem` turns the flat attribute bag of the single `METRICS/CURRENT`
// DynamoDB item into the counter-shaped part of a `MetricsSnapshot`. It only
// imports the shared type (TypeScript only), never AWS/Node/DOM, so the ESLint
// domain boundary is respected.

/** Attribute name holding the reset epoch (milliseconds; 0 before any reset). */
export const EPOCH_ATTRIBUTE = 'epoch';

/** Prefix of the per-link click counters: `l#<linkId>`. */
const LINK_CLICKS_PREFIX = 'l#';

/** Prefix of the per-channel click counters: `cc#<channel>`. */
const CHANNEL_CLICKS_PREFIX = 'cc#';

/** Prefix of the per-channel visit counters: `cv#<channel>`. */
const CHANNEL_VISITS_PREFIX = 'cv#';

/** Prefix of the per-minute click counters: `m#<minuteSec>`. */
const MINUTE_CLICKS_PREFIX = 'm#';

/** Milliseconds in one second, used to turn a Minute start into an ISO string. */
const MS_PER_SECOND = 1000;

/**
 * The part of a `MetricsSnapshot` that `parseMetricsItem` can build from the
 * metrics item alone.
 *
 * `serverTime` and `events` are intentionally excluded: they are not stored in
 * the metrics item. `getMetrics` (task 6.2) adds `serverTime` (from the Clock)
 * and `events` (from the EventRepository), and also filters `links` down to the
 * links that still exist (Requirement 6.5). This function reflects the stored
 * counters as-is, so on its own it already satisfies the arithmetic of
 * Requirement 7.7 for the data it owns (channel sums equal the totals, because
 * every click and visit increments both a total and a channel counter in the
 * same atomic `ADD`).
 */
export type ParsedMetrics = Pick<
  MetricsSnapshot,
  'epoch' | 'totals' | 'links' | 'minutes' | 'channels'
>;

/**
 * Reads one optional non-negative counter attribute, defaulting to 0.
 *
 * Any attribute that is missing or not a finite number is treated as 0 so an
 * unexpected shape never throws. This is the defensive parsing the task asks
 * for: unknown or malformed values are ignored rather than propagated.
 */
function readCounter(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Ensures the per-channel entry for `channel` exists and returns it, so clicks
 * (`cc#`) and visits (`cv#`) for the same channel accumulate into one record.
 */
function channelEntry(
  channels: Record<string, { clicks: number; visits: number }>,
  channel: string,
): { clicks: number; visits: number } {
  const existing = channels[channel];
  if (existing !== undefined) {
    return existing;
  }
  const created = { clicks: 0, visits: 0 };
  channels[channel] = created;
  return created;
}

/**
 * Parses the flat attribute bag of the `METRICS/CURRENT` item into the
 * counter-shaped part of a `MetricsSnapshot`.
 *
 * Behaviour (Requirements 7.2, 7.3, 7.7, 16.8):
 * - Totals: `totalClicks` -> `totals.clicks`, `totalVisits` -> `totals.visits`,
 *   each defaulting to 0 (Requirement 7.2).
 * - Per link: every `l#<linkId>` attribute becomes `links[linkId]`. Filtering
 *   to the links that still exist happens later, in `getMetrics` (6.5).
 * - Per channel: `cc#<channel>` fills `channels[channel].clicks` and
 *   `cv#<channel>` fills `channels[channel].visits`, merged into one entry.
 * - Per minute: only the last 60 Minutes relative to `nowMs` are kept. The
 *   allowed Minute starts (Unix seconds) come from `lastMinutes(nowMs, 60)`;
 *   any `m#<minuteSec>` outside that window is discarded (Requirements 7.3).
 *   The seconds -> ISO 8601 conversion lives here: the output keys are ISO
 *   strings, matching `MetricsSnapshot.minutes`.
 * - `epoch`: the `epoch` attribute, or 0 when it is missing (16.8 / design D17).
 * - Any other attribute (`pk`, `sk`, `ttl`, or anything unrecognised) is ignored
 *   without failing.
 *
 * Only the counter part of the snapshot is produced; `serverTime` and `events`
 * are added by `getMetrics`. See `ParsedMetrics`.
 *
 * @param item Flat metrics-item attributes read from DynamoDB.
 * @param nowMs Current Unix timestamp in milliseconds, used for the 60-Minute window.
 */
export function parseMetricsItem(
  item: Readonly<Record<string, unknown>>,
  nowMs: number,
): ParsedMetrics {
  const links: Record<string, number> = {};
  const channels: Record<string, { clicks: number; visits: number }> = {};
  const minutes: Record<string, number> = {};

  // The Minutes allowed in the output, as a set of Unix-second starts. Minutes
  // outside this window are dropped before conversion to ISO.
  const allowedMinutes = new Set(lastMinutes(nowMs, 60));

  for (const [key, rawValue] of Object.entries(item)) {
    if (key.startsWith(LINK_CLICKS_PREFIX)) {
      const linkId = key.slice(LINK_CLICKS_PREFIX.length);
      links[linkId] = readCounter(rawValue);
    } else if (key.startsWith(CHANNEL_CLICKS_PREFIX)) {
      const channel = key.slice(CHANNEL_CLICKS_PREFIX.length);
      channelEntry(channels, channel).clicks = readCounter(rawValue);
    } else if (key.startsWith(CHANNEL_VISITS_PREFIX)) {
      const channel = key.slice(CHANNEL_VISITS_PREFIX.length);
      channelEntry(channels, channel).visits = readCounter(rawValue);
    } else if (key.startsWith(MINUTE_CLICKS_PREFIX)) {
      const minuteSec = Number(key.slice(MINUTE_CLICKS_PREFIX.length));
      if (Number.isInteger(minuteSec) && allowedMinutes.has(minuteSec)) {
        const iso = new Date(minuteSec * MS_PER_SECOND).toISOString();
        minutes[iso] = readCounter(rawValue);
      }
    }
    // Totals and any unknown attribute (pk, sk, ttl, epoch, ...) fall through
    // and are handled explicitly below or ignored.
  }

  return {
    epoch: readCounter(item[EPOCH_ATTRIBUTE]),
    totals: {
      clicks: readCounter(item[TOTAL_CLICKS_ATTRIBUTE]),
      visits: readCounter(item[TOTAL_VISITS_ATTRIBUTE]),
    },
    links,
    minutes,
    channels,
  };
}
