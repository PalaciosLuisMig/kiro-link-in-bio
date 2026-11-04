import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  KEEPALIVE,
  serialize,
  snapshotMessage,
  type MetricsSnapshot,
  type TicketResponse,
} from '@link-in-bio/shared';

import { ApiError } from '../lib/api.js';

import { UnauthorizedError } from './api.js';
import {
  KEEPALIVE_INTERVAL_MS,
  MAX_RECONNECT_DELAY_MS,
  METRICS_REFRESH_MS,
  METRICS_RETRY_MS,
  reconnectDelayMs,
  startRealtime,
  type ConnectionStatus,
  type WebSocketLike,
} from './realtime.js';

// Tests of the WebSocket client (task 15.9), with a fake socket, a fake API and
// fake time: retries, a new ticket before every attempt, the wait between them,
// the metrics requests, the keepalive, a 401, and logging out.
//
// Feature: link-in-bio, Property 15: Espera de reconexión
// Validates: Requirements 5.14, 8.12, 8.13, 10.1 to 10.8.

const numRuns = Number(import.meta.env.FC_NUM_RUNS ?? '100');

const SECOND = 1000;
const WS_URL = 'wss://example.test/prod';

class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.({});
  }

  receive(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** The server or the network closes the connection. */
  drop(): void {
    this.onclose?.({});
  }
}

const SNAPSHOT: MetricsSnapshot = {
  epoch: 0,
  serverTime: '2026-11-03T12:00:00.000Z',
  totals: { clicks: 3, visits: 1 },
  links: {},
  minutes: {},
  channels: {},
  events: [],
};

interface Harness {
  readonly sockets: FakeSocket[];
  readonly statuses: ConnectionStatus[];
  readonly snapshots: MetricsSnapshot[];
  readonly unauthorized: { count: number };
  readonly tickets: { issued: number; next: () => Promise<TicketResponse> };
  readonly metrics: { calls: number; next: () => Promise<MetricsSnapshot> };
  readonly client: ReturnType<typeof startRealtime>;
  /** The last socket, which the client has just created. */
  last: () => FakeSocket;
}

function start(overrides: Partial<Pick<Harness['tickets'], 'next'>> = {}): Harness {
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const snapshots: MetricsSnapshot[] = [];
  const unauthorized = { count: 0 };
  const tickets = {
    issued: 0,
    next: async (): Promise<TicketResponse> => ({
      ticket: `ticket-${tickets.issued}`,
      expiresAt: 0,
      wsUrl: WS_URL,
    }),
  };
  if (overrides.next !== undefined) {
    tickets.next = overrides.next;
  }
  const metrics = { calls: 0, next: async (): Promise<MetricsSnapshot> => SNAPSHOT };

  const client = startRealtime({
    api: {
      issueTicket: async () => {
        tickets.issued += 1;
        return tickets.next();
      },
      getMetrics: async () => {
        metrics.calls += 1;
        return metrics.next();
      },
    },
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onStatus: (status) => statuses.push(status),
    onUnauthorized: () => {
      unauthorized.count += 1;
    },
  });

  return {
    sockets,
    statuses,
    snapshots,
    unauthorized,
    tickets,
    metrics,
    client,
    last: () => sockets[sockets.length - 1] as FakeSocket,
  };
}

/** Lets pending promises settle and moves the fake clock. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Property 15: wait between attempts', () => {
  test('is 1, 2, 4, 8, 16 s and then 30 s (10.1)', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map(reconnectDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000,
    ]);
  });

  test('is min(2^n x 1 s, 30 s) for any number of failed attempts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (failed) => {
        expect(reconnectDelayMs(failed)).toBe(
          Math.min(2 ** failed * SECOND, MAX_RECONNECT_DELAY_MS),
        );
      }),
      { numRuns },
    );
  });

  test('is at least 1 s, never above 30 s, and never shrinks as attempts fail', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), (failed) => {
        const delay = reconnectDelayMs(failed);
        expect(delay).toBeGreaterThanOrEqual(SECOND);
        expect(delay).toBeLessThanOrEqual(MAX_RECONNECT_DELAY_MS);
        expect(reconnectDelayMs(failed + 1)).toBeGreaterThanOrEqual(delay);
      }),
      { numRuns },
    );
  });

  test('a negative or fractional count is treated as a valid attempt number', () => {
    expect(reconnectDelayMs(-3)).toBe(1000);
    expect(reconnectDelayMs(2.9)).toBe(4000);
  });
});

describe('connecting', () => {
  test('shows "connecting" at once, asks for a ticket and opens the URL with it only', async () => {
    const h = start();
    expect(h.statuses[0]).toBe('connecting');
    await advance(0);

    expect(h.tickets.issued).toBe(1);
    expect(h.sockets).toHaveLength(1);
    expect(h.last().url).toBe(`${WS_URL}?ticket=ticket-1`);
    h.client.stop();
  });

  test('the URL has only the ticket, never anything else (5.14)', async () => {
    const h = start({
      next: async () => ({ ticket: 'a b/c+d', expiresAt: 0, wsUrl: WS_URL }),
    });
    await advance(0);
    expect(h.last().url).toBe(`${WS_URL}?ticket=a%20b%2Fc%2Bd`);
    expect(new URL(h.last().url).searchParams.size).toBe(1);
    h.client.stop();
  });

  test('opening shows "open" and asks for the metrics (10.3)', async () => {
    const h = start();
    await advance(0);
    h.last().open();
    await advance(0);

    expect(h.statuses.at(-1)).toBe('open');
    expect(h.metrics.calls).toBe(1);
    expect(h.snapshots).toEqual([SNAPSHOT]);
    h.client.stop();
  });
});

describe('metrics while the connection is open', () => {
  test('are asked again every 30 s (8.12)', async () => {
    const h = start();
    await advance(0);
    h.last().open();
    await advance(0);
    expect(h.metrics.calls).toBe(1);

    await advance(METRICS_REFRESH_MS - 1);
    expect(h.metrics.calls).toBe(1);
    await advance(1);
    expect(h.metrics.calls).toBe(2);
    await advance(METRICS_REFRESH_MS);
    expect(h.metrics.calls).toBe(3);
    h.client.stop();
  });

  test('if the first request fails, they repeat every 5 s until one works (10.6)', async () => {
    const h = start();
    let failures = 2;
    h.metrics.next = async () => {
      if (failures > 0) {
        failures -= 1;
        throw new ApiError('timeout');
      }
      return SNAPSHOT;
    };
    await advance(0);
    h.last().open();
    await advance(0);
    expect(h.metrics.calls).toBe(1);
    expect(h.snapshots).toEqual([]);

    await advance(METRICS_RETRY_MS);
    expect(h.metrics.calls).toBe(2);
    await advance(METRICS_RETRY_MS);
    expect(h.metrics.calls).toBe(3);
    expect(h.snapshots).toEqual([SNAPSHOT]);

    // Once it works, it goes back to every 30 s.
    await advance(METRICS_RETRY_MS);
    expect(h.metrics.calls).toBe(3);
    await advance(METRICS_REFRESH_MS - METRICS_RETRY_MS);
    expect(h.metrics.calls).toBe(4);
    h.client.stop();
  });

  test('a failed request keeps the connection open and shows nothing new', async () => {
    const h = start();
    h.metrics.next = async () => {
      throw new ApiError('network');
    };
    await advance(0);
    h.last().open();
    await advance(METRICS_RETRY_MS * 3);
    expect(h.statuses.at(-1)).toBe('open');
    expect(h.last().closed).toBe(false);
    h.client.stop();
  });

  test('a 401 on the metrics stops everything and reports it', async () => {
    const h = start();
    h.metrics.next = async () => {
      throw new UnauthorizedError();
    };
    await advance(0);
    h.last().open();
    await advance(0);

    expect(h.unauthorized.count).toBe(1);
    expect(h.statuses.at(-1)).toBe('stopped');
    expect(h.last().closed).toBe(true);
    const tickets = h.tickets.issued;
    await advance(10 * 60 * SECOND);
    expect(h.tickets.issued).toBe(tickets);
    expect(h.metrics.calls).toBe(1);
  });
});

describe('messages', () => {
  test('a valid snapshot reaches the Panel', async () => {
    const h = start();
    await advance(0);
    h.last().open();
    await advance(0);
    h.snapshots.length = 0;

    const live: MetricsSnapshot = { ...SNAPSHOT, totals: { clicks: 9, visits: 4 } };
    h.last().receive(serialize(snapshotMessage(live)));
    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]?.totals).toEqual({ clicks: 9, visits: 4 });
    h.client.stop();
  });

  test.each([
    ['not JSON', 'oops'],
    ['an incomplete snapshot', '{"type":"snapshot","epoch":1}'],
    ['a wrong type', '{"type":"keepalive"}'],
    ['a wrong shape', JSON.stringify({ type: 'snapshot', ...SNAPSHOT, totals: 'many' })],
    ['a binary frame', new ArrayBuffer(8)],
    ['an empty string', ''],
  ])('%s is dropped whole and the connection stays open (8.6)', async (_name, data) => {
    const h = start();
    await advance(0);
    h.last().open();
    await advance(0);
    h.snapshots.length = 0;
    const statuses = h.statuses.length;

    h.last().receive(data);

    expect(h.snapshots).toEqual([]);
    expect(h.statuses).toHaveLength(statuses);
    expect(h.last().closed).toBe(false);
    h.client.stop();
  });
});

describe('keepalive', () => {
  test('is sent every 5 minutes and not before (8.13)', async () => {
    const h = start();
    await advance(0);
    h.last().open();
    await advance(KEEPALIVE_INTERVAL_MS - 1);
    expect(h.last().sent).toEqual([]);

    await advance(1);
    expect(h.last().sent).toEqual([JSON.stringify(KEEPALIVE)]);
    await advance(KEEPALIVE_INTERVAL_MS);
    expect(h.last().sent).toHaveLength(2);
    h.client.stop();
  });

  test('is not sent before the connection opens or after it closes', async () => {
    const h = start();
    await advance(0);
    await advance(KEEPALIVE_INTERVAL_MS * 2);
    expect(h.last().sent).toEqual([]);

    h.last().open();
    const first = h.last();
    h.last().drop();
    await advance(KEEPALIVE_INTERVAL_MS * 2);
    expect(first.sent).toEqual([]);
    h.client.stop();
  });

  test('a connection that closes unexpectedly after 2 hours reconnects', async () => {
    const h = start();
    await advance(0);
    h.last().open();
    await advance(2 * 60 * 60 * SECOND);
    expect(h.last().sent).toHaveLength(24); // one every 5 minutes for 2 hours
    expect(h.statuses.at(-1)).toBe('open');

    const before = h.sockets.length;
    h.last().drop();
    expect(h.statuses.at(-1)).toBe('reconnecting');
    await advance(SECOND);
    expect(h.sockets.length).toBe(before + 1);
    h.client.stop();
  });
});

describe('reconnecting (10.1, 10.2, 10.4, 10.8)', () => {
  test('after an open connection closes: 1 s, then 2, 4, 8, 16 and 30 s, with a new ticket each time', async () => {
    const h = start();
    await advance(0);
    h.last().open();
    h.last().drop();
    expect(h.statuses.at(-1)).toBe('reconnecting');

    const waits = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000];
    let tickets = h.tickets.issued;
    for (const wait of waits) {
      await advance(wait - 1);
      expect(h.tickets.issued).toBe(tickets); // not yet
      await advance(1);
      tickets += 1;
      expect(h.tickets.issued).toBe(tickets); // exactly on time, and a new ticket
      expect(h.last().url).toBe(`${WS_URL}?ticket=ticket-${tickets}`);
      h.last().drop(); // the attempt fails before opening
    }
    h.client.stop();
  });

  test('opening again restores the 1 s wait and hides the indicator (10.4)', async () => {
    const h = start();
    await advance(0);
    h.last().open();
    h.last().drop();
    await advance(1000);
    h.last().drop(); // failed attempt
    await advance(2000);
    h.last().open(); // this one works
    expect(h.statuses.at(-1)).toBe('open');

    const sockets = h.sockets.length;
    h.last().drop();
    await advance(999);
    expect(h.sockets.length).toBe(sockets);
    await advance(1);
    expect(h.sockets.length).toBe(sockets + 1);
    h.client.stop();
  });

  test('"Conectando…" for the first connection, "Reconectando…" after it opened (10.2)', async () => {
    const h = start();
    expect(h.statuses).toEqual(['connecting']);
    await advance(0);
    h.last().drop(); // the very first attempt fails: still the first connection
    expect(h.statuses.at(-1)).toBe('connecting');
    await advance(1000);
    h.last().open();
    expect(h.statuses.at(-1)).toBe('open');

    h.last().drop();
    expect(h.statuses.at(-1)).toBe('reconnecting');
    await advance(1000);
    expect(h.statuses.at(-1)).toBe('reconnecting');
    h.client.stop();
  });

  test('the indicator shows at once, never after a wait (10.2: within 1 s)', async () => {
    const h = start();
    await advance(0);
    h.last().open();
    h.last().drop();
    // No time has passed since the close, and it already says so.
    expect(h.statuses.at(-1)).toBe('reconnecting');
    h.client.stop();
  });

  test('a ticket request that fails (not 401) counts as a failed attempt (10.8)', async () => {
    let failing = true;
    const h = start({
      next: async () => {
        if (failing) {
          throw new ApiError('timeout');
        }
        return { ticket: 'ok', expiresAt: 0, wsUrl: WS_URL };
      },
    });
    await advance(0);
    expect(h.tickets.issued).toBe(1);
    expect(h.sockets).toHaveLength(0);

    await advance(1000);
    expect(h.tickets.issued).toBe(2);
    await advance(2000);
    expect(h.tickets.issued).toBe(3);
    await advance(3999);
    expect(h.tickets.issued).toBe(3);
    failing = false;
    await advance(1);
    expect(h.tickets.issued).toBe(4);
    expect(h.sockets).toHaveLength(1);
    expect(h.unauthorized.count).toBe(0);
    h.client.stop();
  });

  test('a socket that closes before opening (rejected ticket) is a failed attempt', async () => {
    const h = start();
    await advance(0);
    h.last().drop();
    await advance(1000);
    expect(h.sockets).toHaveLength(2);
    h.last().onerror?.({}); // an error event counts the same as a close
    await advance(1999);
    expect(h.sockets).toHaveLength(2);
    await advance(1);
    expect(h.sockets).toHaveLength(3);
    h.client.stop();
  });

  test('a close followed by an error is one failure, not two', async () => {
    const h = start();
    await advance(0);
    h.last().open();
    const socket = h.last();
    socket.drop();
    socket.onerror?.({});
    await advance(1000);
    expect(h.sockets).toHaveLength(2);
    await advance(10_000);
    // Only one retry was scheduled: the second attempt is still pending its own.
    expect(h.tickets.issued).toBe(2);
    h.client.stop();
  });
});

describe('401 on the ticket (10.5)', () => {
  test('stops the retries, reports it and hides the indicator', async () => {
    const h = start({
      next: async () => {
        throw new UnauthorizedError();
      },
    });
    await advance(0);

    expect(h.unauthorized.count).toBe(1);
    expect(h.statuses.at(-1)).toBe('stopped');
    expect(h.sockets).toHaveLength(0);
    await advance(10 * 60 * SECOND);
    expect(h.tickets.issued).toBe(1);
  });

  test('a 401 while reconnecting stops the retries too', async () => {
    let unauthorizedNow = false;
    const h = start({
      next: async () => {
        if (unauthorizedNow) {
          throw new UnauthorizedError();
        }
        return { ticket: 'ok', expiresAt: 0, wsUrl: WS_URL };
      },
    });
    await advance(0);
    h.last().open();
    h.last().drop();
    unauthorizedNow = true;
    await advance(1000);
    expect(h.unauthorized.count).toBe(1);
    expect(h.statuses.at(-1)).toBe('stopped');
    const tickets = h.tickets.issued;
    await advance(10 * 60 * SECOND);
    expect(h.tickets.issued).toBe(tickets);
  });
});

describe('logging out (10.7)', () => {
  test('cancels the pending retry and hides the indicator', async () => {
    const h = start();
    await advance(0);
    h.last().open();
    h.last().drop();
    const tickets = h.tickets.issued;

    h.client.stop();
    expect(h.statuses.at(-1)).toBe('stopped');
    // Nothing is left scheduled: the retry timer was cancelled, not just ignored.
    expect(vi.getTimerCount()).toBe(0);
    await advance(10 * 60 * SECOND);
    expect(h.tickets.issued).toBe(tickets);
    expect(h.sockets).toHaveLength(1);
  });

  test('closes the open socket and stops the metrics and the keepalive', async () => {
    const h = start();
    await advance(0);
    h.last().open();
    await advance(0);
    const socket = h.last();
    const calls = h.metrics.calls;

    h.client.stop();
    expect(socket.closed).toBe(true);
    await advance(KEEPALIVE_INTERVAL_MS * 3);
    expect(h.metrics.calls).toBe(calls);
    expect(socket.sent).toEqual([]);
  });

  test('stopping while a ticket is being requested opens no socket afterwards', async () => {
    let release!: (ticket: TicketResponse) => void;
    const h = start({
      next: () =>
        new Promise<TicketResponse>((resolve) => {
          release = resolve;
        }),
    });
    await advance(0);
    h.client.stop();
    release({ ticket: 'late', expiresAt: 0, wsUrl: WS_URL });
    await advance(0);
    expect(h.sockets).toHaveLength(0);
  });

  test('events of a closed socket after stopping change nothing', async () => {
    const h = start();
    await advance(0);
    const socket = h.last();
    socket.open();
    h.client.stop();
    const statuses = h.statuses.length;

    socket.drop();
    socket.receive(serialize(snapshotMessage(SNAPSHOT)));
    await advance(60 * SECOND);
    expect(h.statuses).toHaveLength(statuses);
    expect(h.sockets).toHaveLength(1);
  });

  test('stopping twice is harmless', async () => {
    const h = start();
    await advance(0);
    h.client.stop();
    expect(() => h.client.stop()).not.toThrow();
    expect(h.statuses.filter((status) => status === 'stopped')).toHaveLength(1);
  });
});
