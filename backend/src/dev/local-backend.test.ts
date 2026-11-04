import { beforeEach, describe, expect, test, vi } from 'vitest';

import { parse, type MetricsSnapshot } from '@link-in-bio/shared';

import { FakeClock, RecordingLogger } from '../lib/domain/testing/fakes.js';
import type { HttpRequest, HttpResponse } from '../lib/http/types.js';

import { createLocalBackend, SEED_LINKS, type LocalBackend } from './local-backend.js';

// Tests of the backend for local development: the real handlers on in-memory
// doubles. They check the same flows the Panel and the public page depend on,
// including what the real-time delivery does when clicks arrive.

const TOKEN = 't'.repeat(40);
const WS_URL = 'ws://localhost:5173/ws';

let clock: FakeClock;
let logger: RecordingLogger;
let backend: LocalBackend;

beforeEach(async () => {
  clock = new FakeClock(1_700_000_000_000);
  logger = new RecordingLogger();
  backend = await createLocalBackend({ ownerToken: TOKEN, wsUrl: WS_URL, clock, logger });
});

function request(
  routeKey: string,
  options: { body?: unknown; token?: string | null; id?: string } = {},
): HttpRequest {
  const token = options.token === undefined ? TOKEN : options.token;
  return {
    routeKey,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    pathParameters: options.id === undefined ? undefined : { id: options.id },
    requestId: 'req-1',
  };
}

const json = <T>(response: HttpResponse): T => JSON.parse(response.body ?? 'null') as T;

async function publicLinks(): Promise<{ id: string; title: string }[]> {
  const response = await backend.handleHttp(request('GET /api/links', { token: null }));
  return json<{ links: { id: string; title: string }[] }>(response).links;
}

async function metrics(): Promise<MetricsSnapshot> {
  return json<MetricsSnapshot>(await backend.handleHttp(request('GET /api/admin/metrics')));
}

async function click(linkId: string): Promise<HttpResponse> {
  return backend.handleHttp(request('POST /api/clicks', { token: null, body: { linkId } }));
}

async function newTicket(): Promise<string> {
  const response = await backend.handleHttp(request('POST /api/admin/realtime-tickets'));
  return json<{ ticket: string }>(response).ticket;
}

/** A connected Panel: it collects every snapshot the server sends to it. */
async function connectPanel(): Promise<{ id: string; received: MetricsSnapshot[] }> {
  const connection = await backend.connect(await newTicket());
  if (connection === null) {
    throw new Error('the connection was refused');
  }
  const received: MetricsSnapshot[] = [];
  backend.attach(connection.connectionId, (text) => {
    const parsed = parse(text);
    if (parsed.ok) {
      received.push(parsed.value);
    }
    return true;
  });
  return { id: connection.connectionId, received };
}

describe('the public page', () => {
  test('starts with the sample links, so it is not empty the first time', async () => {
    expect((await publicLinks()).map((link) => link.title)).toEqual(
      SEED_LINKS.map((sample) => sample.title),
    );
  });

  test('can start with no links', async () => {
    const empty = await createLocalBackend({
      ownerToken: TOKEN,
      wsUrl: WS_URL,
      clock,
      logger,
      seed: false,
    });
    const response = await empty.handleHttp(request('GET /api/links', { token: null }));
    expect(json<{ links: unknown[] }>(response).links).toEqual([]);
  });

  test('a click and a visit are counted and show in the metrics', async () => {
    const [first] = await publicLinks();
    expect((await click(first?.id ?? '')).statusCode).toBe(202);
    await backend.handleHttp(request('POST /api/visits', { token: null, body: { channel: 'qr' } }));

    const snapshot = await metrics();
    expect(snapshot.totals).toEqual({ clicks: 1, visits: 1 });
    expect(snapshot.links[first?.id ?? '']).toBe(1);
    expect(snapshot.events).toHaveLength(2);
  });

  test('a click on an unknown link is a 404 and counts nothing', async () => {
    const response = await click('00000000-0000-4000-8000-000000000000');
    expect(response.statusCode).toBe(404);
    expect((await metrics()).totals.clicks).toBe(0);
  });
});

describe('the admin API', () => {
  test('refuses a missing or wrong token (401)', async () => {
    for (const token of [null, '', 'wrong']) {
      const response = await backend.handleHttp(request('GET /api/admin/metrics', { token }));
      expect(response.statusCode).toBe(401);
    }
  });

  test('creates, edits, reorders and deletes links', async () => {
    const created = json<{ id: string; title: string }>(
      await backend.handleHttp(
        request('POST /api/admin/links', { body: { title: 'Nuevo', url: 'https://nuevo.com' } }),
      ),
    );
    expect(created.title).toBe('Nuevo');
    expect((await publicLinks()).map((link) => link.title)).toContain('Nuevo');

    const patched = await backend.handleHttp(
      request('PATCH /api/admin/links/{id}', { id: created.id, body: { active: false } }),
    );
    expect(patched.statusCode).toBe(200);
    expect((await publicLinks()).map((link) => link.title)).not.toContain('Nuevo');

    const all = json<{ links: { id: string }[] }>(
      await backend.handleHttp(request('GET /api/admin/links')),
    ).links;
    const reversed = all.map((link) => link.id).reverse();
    const reordered = await backend.handleHttp(
      request('PUT /api/admin/links/order', { body: { ids: reversed } }),
    );
    expect(reordered.statusCode).toBe(200);

    const deleted = await backend.handleHttp(
      request('DELETE /api/admin/links/{id}', { id: created.id }),
    );
    expect(deleted.statusCode).toBe(204);
    expect((await publicLinks()).map((link) => link.title)).not.toContain('Nuevo');
  });

  test('refuses an 11th link (409)', async () => {
    for (let n = 0; n < 7; n += 1) {
      await backend.handleHttp(
        request('POST /api/admin/links', { body: { title: `Extra ${n}`, url: 'https://a.com' } }),
      );
    }
    const response = await backend.handleHttp(
      request('POST /api/admin/links', { body: { title: 'Uno más', url: 'https://a.com' } }),
    );
    expect(response.statusCode).toBe(409);
  });

  test('a reorder that is not an exact permutation is rejected with its reason', async () => {
    const response = await backend.handleHttp(
      request('PUT /api/admin/links/order', { body: { ids: [] } }),
    );
    expect(response.statusCode).toBe(400);
    expect(json<{ reason: string }>(response).reason).toBe('ids_not_permutation');
  });

  test('tells the Panel the WebSocket URL to use, with a ticket', async () => {
    const response = await backend.handleHttp(request('POST /api/admin/realtime-tickets'));
    const body = json<{ ticket: string; wsUrl: string }>(response);
    expect(body.wsUrl).toBe(WS_URL);
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('a reset starts a new epoch with everything at zero', async () => {
    const [first] = await publicLinks();
    await click(first?.id ?? '');
    const before = await metrics();

    clock.advance(5000);
    const reset = await backend.handleHttp(request('POST /api/admin/metrics/reset'));
    expect(reset.statusCode).toBe(200);
    const after = await metrics();
    expect(after.epoch).toBeGreaterThan(before.epoch);
    expect(after.totals).toEqual({ clicks: 0, visits: 0 });
    expect(after.events).toEqual([]);
  });
});

describe('the one-time ticket (5.7, 5.16)', () => {
  test('a valid ticket opens a connection, and works only once', async () => {
    const ticket = await newTicket();
    expect(await backend.connect(ticket)).not.toBeNull();
    expect(await backend.connect(ticket)).toBeNull();
  });

  test('a missing, malformed or unknown ticket is refused', async () => {
    for (const ticket of [undefined, '', 'short', 'A'.repeat(43)]) {
      expect(await backend.connect(ticket)).toBeNull();
    }
  });

  test('an expired ticket is refused', async () => {
    const ticket = await newTicket();
    clock.advance(60_000);
    expect(await backend.connect(ticket)).toBeNull();
  });
});

describe('real-time delivery to connected Panels', () => {
  test('a click sends the new snapshot to every connected Panel', async () => {
    const [first] = await publicLinks();
    const a = await connectPanel();
    const b = await connectPanel();

    await click(first?.id ?? '');
    await backend.idle();

    for (const panel of [a, b]) {
      expect(panel.received).toHaveLength(1);
      expect(panel.received[0]?.totals.clicks).toBe(1);
      expect(panel.received[0]?.links[first?.id ?? '']).toBe(1);
      expect(panel.received[0]?.events[0]?.type).toBe('click');
    }
  });

  test('a visit and a reset are delivered too, with the new epoch', async () => {
    const panel = await connectPanel();
    await backend.handleHttp(request('POST /api/visits', { token: null, body: {} }));
    await backend.idle();
    expect(panel.received.at(-1)?.totals.visits).toBe(1);

    clock.advance(5000);
    await backend.handleHttp(request('POST /api/admin/metrics/reset'));
    await backend.idle();
    const last = panel.received.at(-1);
    expect(last?.totals).toEqual({ clicks: 0, visits: 0 });
    expect((last?.epoch ?? 0) > 0).toBe(true);
  });

  test('keeps at least 1 s between sends, as the Lambda does (8.7)', async () => {
    const [first] = await publicLinks();
    await connectPanel();
    await click(first?.id ?? '');
    await backend.idle();
    expect(clock.sleeps).toEqual([1000]);
  });

  test('sends nothing when nobody is connected, and does not wait', async () => {
    const [first] = await publicLinks();
    await click(first?.id ?? '');
    await backend.idle();
    expect(clock.sleeps).toEqual([]);
  });

  test('a click that fails is not delivered', async () => {
    const panel = await connectPanel();
    await click('00000000-0000-4000-8000-000000000000');
    await backend.idle();
    expect(panel.received).toEqual([]);
  });

  test('a Panel that disconnected receives nothing more', async () => {
    const [first] = await publicLinks();
    const panel = await connectPanel();
    await backend.disconnect(panel.id);
    await click(first?.id ?? '');
    await backend.idle();
    expect(panel.received).toEqual([]);
  });

  test('a socket that reports it is closed is forgotten, not retried', async () => {
    const [first] = await publicLinks();
    const connection = await backend.connect(await newTicket());
    let calls = 0;
    backend.attach(connection?.connectionId ?? '', () => {
      calls += 1;
      return false; // closed
    });

    await click(first?.id ?? '');
    await backend.idle();
    await click(first?.id ?? '');
    await backend.idle();
    expect(calls).toBe(1);
  });

  test('a connection that has not attached its socket yet is kept, not dropped', async () => {
    const [first] = await publicLinks();
    const connection = await backend.connect(await newTicket());
    await click(first?.id ?? '');
    await backend.idle();

    const received: MetricsSnapshot[] = [];
    backend.attach(connection?.connectionId ?? '', (text) => {
      const parsed = parse(text);
      if (parsed.ok) {
        received.push(parsed.value);
      }
      return true;
    });
    await click(first?.id ?? '');
    await backend.idle();
    expect(received).toHaveLength(1);
    expect(received[0]?.totals.clicks).toBe(2);
  });

  test('a click that arrives WHILE a notification runs is delivered by a following one', async () => {
    // The 1 s pause of a notification is held open, so the second click really lands
    // in the middle of it. (With an instant pause both clicks would be counted before
    // the metrics are read, and one snapshot would carry both: it would prove nothing.)
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowClock = {
      now: () => clock.now(),
      sleep: () => held,
    };
    const slow = await createLocalBackend({
      ownerToken: TOKEN,
      wsUrl: WS_URL,
      clock: slowClock,
      logger,
    });
    const asSlow = (routeKey: string, body?: unknown, token: string | null = null) =>
      slow.handleHttp(request(routeKey, { token, body }));

    const links = json<{ links: { id: string }[] }>(await asSlow('GET /api/links')).links;
    const ticket = json<{ ticket: string }>(
      await asSlow('POST /api/admin/realtime-tickets', undefined, TOKEN),
    ).ticket;
    const connection = await slow.connect(ticket);
    const received: MetricsSnapshot[] = [];
    slow.attach(connection?.connectionId ?? '', (text) => {
      const parsed = parse(text);
      if (parsed.ok) {
        received.push(parsed.value);
      }
      return true;
    });

    await asSlow('POST /api/clicks', { linkId: links[0]?.id });
    await vi.waitFor(() => expect(received).toHaveLength(1)); // sent; now it is in its pause
    expect(received[0]?.totals.clicks).toBe(1);

    await asSlow('POST /api/clicks', { linkId: links[0]?.id }); // arrives during the pause
    release();
    await slow.idle();

    expect(received).toHaveLength(2);
    expect(received[1]?.totals.clicks).toBe(2);
  });

  test('several clicks at once all end up delivered', async () => {
    const [first] = await publicLinks();
    const panel = await connectPanel();
    await Promise.all([click(first?.id ?? ''), click(first?.id ?? ''), click(first?.id ?? '')]);
    await backend.idle();
    expect(panel.received.at(-1)?.totals.clicks).toBe(3);
  });
});

describe('messages from the Panel', () => {
  test('a keepalive is accepted and changes nothing', async () => {
    const panel = await connectPanel();
    await backend.message(panel.id, '{"type":"keepalive"}');
    await backend.message(panel.id, 'garbage');
    expect(panel.received).toEqual([]);
    expect(logger.errors).toEqual([]);
  });
});
