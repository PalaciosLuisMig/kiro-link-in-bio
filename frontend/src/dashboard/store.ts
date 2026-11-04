// Pure reducer of the Panel (task 15.1): the single place where metrics become
// the state the views draw.
//
// There is ONE entry for data, `applySnapshot`, used for the answer of
// `GET /api/admin/metrics` and for every WebSocket message. Nothing in this file
// reads `Date.now()`: the caller passes the local time, so every rule is
// deterministic and tested with properties.
//
// The rules make `applySnapshot` monotonic, idempotent and commutative inside one
// epoch (Property 10): counters take the maximum, the clock comes from the
// snapshot with the greatest server time (ties broken by a total order, not by
// arrival), the 60-minute window only moves forward and the feed is a set with a
// total order.

import { compareChannels, type ActivityEvent, type MetricsSnapshot } from '@link-in-bio/shared';

/** The chart always shows exactly this many consecutive minutes (7.3). */
export const MINUTES_SHOWN = 60;

/** The feed never holds more events than this (9.2). */
export const FEED_LIMIT = 20;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

export interface ChannelCounts {
  readonly clicks: number;
  readonly visits: number;
}

export interface DashboardState {
  /** False until the first snapshot arrives: the views show nothing before. */
  readonly hasSnapshot: boolean;
  /** Metrics epoch shown. 0 until the first reset, then the reset time in ms. */
  readonly epoch: number;
  /**
   * Greatest server time seen (ms) and the offset `serverTime - localTime`
   * measured when it arrived. The offset comes from THAT snapshot, not from the
   * last one applied, so late or reordered snapshots cannot move the clock back.
   */
  readonly serverTimeMs: number;
  readonly clockOffsetMs: number;
  /** Start (Unix seconds) of the last minute of the window. It only grows. */
  readonly windowEndSec: number;
  readonly totals: { readonly clicks: number; readonly visits: number };
  /** linkId -> clicks. */
  readonly links: ReadonlyMap<string, number>;
  /** Minute start (Unix seconds) -> clicks, only minutes inside the window. */
  readonly minutes: ReadonlyMap<number, number>;
  readonly channels: ReadonlyMap<string, ChannelCounts>;
  /** At most 20, newest first. */
  readonly events: readonly ActivityEvent[];
}

/** The state before any data: all counters at 0, no snapshot yet. */
export function initialState(): DashboardState {
  return {
    hasSnapshot: false,
    epoch: 0,
    serverTimeMs: Number.NEGATIVE_INFINITY,
    clockOffsetMs: 0,
    windowEndSec: 0,
    totals: { clicks: 0, visits: 0 },
    links: new Map(),
    minutes: new Map(),
    channels: new Map(),
    events: [],
  };
}

/** Start of the UTC minute that contains `ms`, in Unix seconds. */
export function minuteStartSec(ms: number): number {
  return Math.floor(ms / (MS_PER_SECOND * SECONDS_PER_MINUTE)) * SECONDS_PER_MINUTE;
}

/** First minute (Unix seconds) of the window that ends at `endSec`. */
export function windowStartSec(endSec: number): number {
  return endSec - (MINUTES_SHOWN - 1) * SECONDS_PER_MINUTE;
}

/** Counters only grow inside an epoch: the bigger of the two values wins (8.5). */
function larger(current: number | undefined, received: number): number {
  return Math.max(current ?? 0, received);
}

function mergeCounters<K>(
  current: ReadonlyMap<K, number>,
  received: Iterable<readonly [K, number]>,
): Map<K, number> {
  const merged = new Map(current);
  for (const [key, value] of received) {
    merged.set(key, larger(merged.get(key), value));
  }
  return merged;
}

function mergeChannels(
  current: ReadonlyMap<string, ChannelCounts>,
  received: MetricsSnapshot['channels'],
): Map<string, ChannelCounts> {
  const merged = new Map(current);
  for (const [name, counts] of Object.entries(received)) {
    const known = merged.get(name);
    merged.set(name, {
      clicks: larger(known?.clicks, counts.clicks),
      visits: larger(known?.visits, counts.visits),
    });
  }
  return merged;
}

/** Time of an event in ms; an unreadable one sorts as the oldest possible. */
function eventTimeMs(event: ActivityEvent): number {
  const time = Date.parse(event.at);
  return Number.isFinite(time) ? time : 0;
}

/**
 * Total order of events, newest first: time descending, then id, then the rest of
 * the fields. A TOTAL order is what makes the merge independent of arrival order.
 */
function compareEvents(a: ActivityEvent, b: ActivityEvent): number {
  const byTime = eventTimeMs(b) - eventTimeMs(a);
  if (byTime !== 0) {
    return byTime;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  const rest = (event: ActivityEvent): string =>
    JSON.stringify([event.type, event.channel, event.title ?? '', event.at]);
  const [restA, restB] = [rest(a), rest(b)];
  return restA === restB ? 0 : restA < restB ? -1 : 1;
}

/** Union of two lists of events with no repeated id, newest first, at most 20 (9.1, 9.2). */
function mergeEvents(
  current: readonly ActivityEvent[],
  received: readonly ActivityEvent[],
): ActivityEvent[] {
  const byId = new Map<string, ActivityEvent>();
  for (const event of [...current, ...received]) {
    const known = byId.get(event.id);
    if (known === undefined || compareEvents(event, known) < 0) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()].sort(compareEvents).slice(0, FEED_LIMIT);
}

/** Minute keys of a snapshot as Unix seconds, dropping any key that is not a date. */
function snapshotMinutes(minutes: MetricsSnapshot['minutes']): [number, number][] {
  const result: [number, number][] = [];
  for (const [iso, clicks] of Object.entries(minutes)) {
    const time = Date.parse(iso);
    if (Number.isFinite(time)) {
      result.push([minuteStartSec(time), clicks]);
    }
  }
  return result;
}

/** Keeps only the minutes inside the window that ends at `endSec`. */
function insideWindow(minutes: ReadonlyMap<number, number>, endSec: number): Map<number, number> {
  const start = windowStartSec(endSec);
  const kept = new Map<number, number>();
  for (const [sec, clicks] of minutes) {
    if (sec >= start && sec <= endSec) {
      kept.set(sec, clicks);
    }
  }
  return kept;
}

/**
 * Applies a snapshot (from the HTTP answer or from the WebSocket) to the state.
 *
 * - An OLDER epoch is discarded whole and the state is returned untouched (8.6).
 * - A NEWER epoch replaces the state: it is what a reset produces (16.6).
 * - The same epoch merges: every counter becomes the maximum of what is shown and
 *   what arrived, so a smaller value is ignored and the rest is applied (8.5).
 * - The clock comes from the snapshot with the greatest server time. Between equal
 *   server times the larger offset wins, so the choice never depends on arrival.
 * - The window ends at the latest of: what it was, the minute of the server time,
 *   and the latest minute in the snapshot. A minute before the window is ignored
 *   (8.9) and one after it moves the window forward (8.10).
 *
 * @param localNowMs the browser clock when the snapshot arrived.
 */
export function applySnapshot(
  state: DashboardState,
  snapshot: MetricsSnapshot,
  localNowMs: number,
): DashboardState {
  if (snapshot.epoch < state.epoch) {
    return state;
  }
  const base: DashboardState =
    snapshot.epoch > state.epoch ? { ...initialState(), epoch: snapshot.epoch } : state;

  // Clock: keep the pair (server time, offset) that is greatest in that order.
  const serverMs = Date.parse(snapshot.serverTime);
  let { serverTimeMs, clockOffsetMs } = base;
  if (Number.isFinite(serverMs)) {
    const offset = serverMs - localNowMs;
    if (serverMs > serverTimeMs || (serverMs === serverTimeMs && offset > clockOffsetMs)) {
      serverTimeMs = serverMs;
      clockOffsetMs = offset;
    }
  }

  // Window: it only moves forward.
  const received = snapshotMinutes(snapshot.minutes);
  let windowEndSec = base.windowEndSec;
  if (Number.isFinite(serverMs)) {
    windowEndSec = Math.max(windowEndSec, minuteStartSec(serverMs));
  }
  for (const [sec] of received) {
    windowEndSec = Math.max(windowEndSec, sec);
  }

  return {
    hasSnapshot: true,
    epoch: snapshot.epoch,
    serverTimeMs,
    clockOffsetMs,
    windowEndSec,
    totals: {
      clicks: larger(base.totals.clicks, snapshot.totals.clicks),
      visits: larger(base.totals.visits, snapshot.totals.visits),
    },
    links: mergeCounters(base.links, Object.entries(snapshot.links)),
    minutes: insideWindow(mergeCounters(base.minutes, received), windowEndSec),
    channels: mergeChannels(base.channels, snapshot.channels),
    events: mergeEvents(base.events, snapshot.events),
  };
}

/**
 * Moves the window forward when a new minute begins on the corrected clock (8.4):
 * a new bar at 0 appears and the oldest one leaves. Returns the SAME state object
 * when nothing changed, so a caller can skip drawing.
 */
export function advanceClock(state: DashboardState, localNowMs: number): DashboardState {
  if (!state.hasSnapshot) {
    return state;
  }
  const nowSec = minuteStartSec(localNowMs + state.clockOffsetMs);
  if (nowSec <= state.windowEndSec) {
    return state;
  }
  return {
    ...state,
    windowEndSec: nowSec,
    minutes: insideWindow(state.minutes, nowSec),
  };
}

// --- Selectors ----------------------------------------------------------------

export interface MinuteBar {
  readonly startSec: number;
  readonly clicks: number;
}

/** Exactly 60 consecutive minutes ending at the window end, 0 where there are no clicks (7.3). */
export function windowMinutes(state: DashboardState): MinuteBar[] {
  const start = windowStartSec(state.windowEndSec);
  return Array.from({ length: MINUTES_SHOWN }, (_unused, index) => {
    const startSec = start + index * SECONDS_PER_MINUTE;
    return { startSec, clicks: state.minutes.get(startSec) ?? 0 };
  });
}

export interface ChannelRow extends ChannelCounts {
  readonly name: string;
}

/** Channels with at least one visit or click, by clicks descending then name (7.4, 8.3). */
export function sortedChannels(state: DashboardState): ChannelRow[] {
  return [...state.channels]
    .map(([name, counts]) => ({ name, ...counts }))
    .filter((row) => row.clicks > 0 || row.visits > 0)
    .sort(compareChannels);
}

/** How many events of `next` were not in `previous`: what the live region announces (9.4). */
export function countNewEvents(previous: DashboardState, next: DashboardState): number {
  const known = new Set(previous.events.map((event) => event.id));
  return next.events.filter((event) => !known.has(event.id)).length;
}
