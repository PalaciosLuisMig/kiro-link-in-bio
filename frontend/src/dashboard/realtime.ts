// WebSocket client of the Panel, with reconnection (task 15.8).
//
// Requirements 5.14, 8.12, 8.13 and 10. Before EVERY attempt it asks the API for
// a new one-time ticket and opens `<wsUrl>?ticket=<ticket>`: the URL carries only
// that ticket, never the owner token. The API, the socket and the timers are the
// ones in `deps` and the globals, so the tests drive them with fakes and fake time.

import { KEEPALIVE, parse, type MetricsSnapshot, type TicketResponse } from '@link-in-bio/shared';

import { UnauthorizedError, type AdminApi } from './api.js';

/** What the connection indicator shows (10.2). `stopped` hides it (10.7). */
export type ConnectionStatus = 'connecting' | 'reconnecting' | 'open' | 'stopped';

/** The part of `WebSocket` the client uses, so a test can fake it. */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface RealtimeDeps {
  readonly api: Pick<AdminApi, 'issueTicket' | 'getMetrics'>;
  readonly createSocket: (url: string) => WebSocketLike;
  /** Called with every valid snapshot: from a message or from a metrics request. */
  readonly onSnapshot: (snapshot: MetricsSnapshot) => void;
  readonly onStatus: (status: ConnectionStatus) => void;
  /** The API answered 401: the Panel must forget the token and show the form (10.5). */
  readonly onUnauthorized: () => void;
}

export interface RealtimeClient {
  /** Cancels every retry and timer, closes the socket and hides the indicator (10.7). */
  stop(): void;
}

const SECOND_MS = 1000;
/** The longest wait between two attempts (10.1). */
export const MAX_RECONNECT_DELAY_MS = 30 * SECOND_MS;
/** While open, the metrics are asked again this often (8.12). */
export const METRICS_REFRESH_MS = 30 * SECOND_MS;
/** If the metrics request after connecting fails, it repeats this often (10.6). */
export const METRICS_RETRY_MS = 5 * SECOND_MS;
/** A keepalive goes out this often so the connection is not closed as idle (8.13). */
export const KEEPALIVE_INTERVAL_MS = 5 * 60 * SECOND_MS;

/**
 * Wait before the next attempt: `min(2^n × 1 s, 30 s)` for `n` failed attempts, so
 * 1, 2, 4, 8, 16, 30, 30... seconds (10.1).
 */
export function reconnectDelayMs(failedAttempts: number): number {
  const attempts = Math.max(0, Math.floor(failedAttempts));
  return Math.min(SECOND_MS * 2 ** attempts, MAX_RECONNECT_DELAY_MS);
}

export function startRealtime(deps: RealtimeDeps): RealtimeClient {
  let stopped = false;
  let hasOpened = false;
  let retries = 0;
  let socket: WebSocketLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let metricsTimer: ReturnType<typeof setTimeout> | undefined;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  /** "Conectando…" for the first connection of the page load, "Reconectando…" after. */
  const waitingStatus = (): ConnectionStatus => (hasOpened ? 'reconnecting' : 'connecting');

  const clearOpenTimers = (): void => {
    clearTimeout(metricsTimer);
    clearInterval(keepaliveTimer);
    metricsTimer = undefined;
    keepaliveTimer = undefined;
  };

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(retryTimer);
    clearOpenTimers();
    const closing = socket;
    socket = null;
    try {
      closing?.close();
    } catch {
      // Already closed.
    }
    deps.onStatus('stopped');
  };

  const unauthorized = (): void => {
    stop();
    deps.onUnauthorized();
  };

  const scheduleRetry = (): void => {
    if (stopped) {
      return;
    }
    deps.onStatus(waitingStatus());
    const delay = reconnectDelayMs(retries);
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, delay);
  };

  /** Asks for the metrics; on success again in 30 s, on failure again in 5 s (8.12, 10.6). */
  const refreshMetrics = async (current: WebSocketLike): Promise<void> => {
    metricsTimer = undefined;
    try {
      const snapshot = await deps.api.getMetrics();
      if (stopped || socket !== current) {
        return;
      }
      deps.onSnapshot(snapshot);
      metricsTimer = setTimeout(() => void refreshMetrics(current), METRICS_REFRESH_MS);
    } catch (error) {
      if (stopped || socket !== current) {
        return;
      }
      if (error instanceof UnauthorizedError) {
        unauthorized();
        return;
      }
      // Keep what is shown and try again soon, until a valid answer arrives.
      metricsTimer = setTimeout(() => void refreshMetrics(current), METRICS_RETRY_MS);
    }
  };

  const connect = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    deps.onStatus(waitingStatus());

    let ticket: TicketResponse;
    try {
      ticket = await deps.api.issueTicket();
    } catch (error) {
      if (stopped) {
        return;
      }
      if (error instanceof UnauthorizedError) {
        unauthorized();
        return;
      }
      scheduleRetry(); // any other failure is a failed attempt (10.8)
      return;
    }
    if (stopped) {
      return;
    }

    let current: WebSocketLike;
    try {
      current = deps.createSocket(`${ticket.wsUrl}?ticket=${encodeURIComponent(ticket.ticket)}`);
    } catch {
      scheduleRetry();
      return;
    }
    socket = current;

    let lost = false;
    const onLost = (): void => {
      if (lost || stopped || socket !== current) {
        return;
      }
      lost = true;
      socket = null;
      clearOpenTimers();
      scheduleRetry();
    };

    current.onopen = () => {
      if (stopped || socket !== current) {
        return;
      }
      hasOpened = true;
      retries = 0; // the next cycle of waits starts again at 1 s (10.4)
      deps.onStatus('open');
      void refreshMetrics(current);
      keepaliveTimer = setInterval(() => {
        try {
          current.send(JSON.stringify(KEEPALIVE));
        } catch {
          // A broken socket reports itself through `onclose`.
        }
      }, KEEPALIVE_INTERVAL_MS);
    };

    current.onmessage = (event) => {
      if (stopped || socket !== current || typeof event.data !== 'string') {
        return;
      }
      // A message that breaks the contract is dropped whole and the connection
      // stays open (8.6).
      const result = parse(event.data);
      if (result.ok) {
        deps.onSnapshot(result.value);
      }
    };

    current.onclose = onLost;
    current.onerror = onLost;
  };

  void connect();
  return { stop };
}
