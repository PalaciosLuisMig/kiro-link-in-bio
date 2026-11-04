import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';

import { parse, type MetricsSnapshot } from '@link-in-bio/shared';

import { RecordingLogger } from '../lib/domain/testing/fakes.js';

import { SEED_LINKS } from './local-backend.js';
import { createLocalServer, type LocalServer } from './local-server.js';

// Tests of the local development server with a REAL http server and a REAL
// WebSocket client on an ephemeral port: the request-to-route translation, the
// answers, and the WebSocket handshake with its one-time ticket.

const TOKEN = 't'.repeat(40);

let app: LocalServer;
let base: string;
let wsBase: string;

beforeEach(async () => {
  app = await createLocalServer({
    ownerToken: TOKEN,
    wsUrl: 'ws://placeholder',
    logger: new RecordingLogger(),
  });
  const port = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}/ws`;
});

afterEach(async () => {
  await app.close();
});

const admin = { Authorization: `Bearer ${TOKEN}` };

async function getLinks(): Promise<{ id: string; title: string }[]> {
  const response = await fetch(`${base}/api/links`);
  return ((await response.json()) as { links: { id: string; title: string }[] }).links;
}

async function issueTicket(): Promise<string> {
  const response = await fetch(`${base}/api/admin/realtime-tickets`, {
    method: 'POST',
    headers: admin,
  });
  return ((await response.json()) as { ticket: string }).ticket;
}

/** Opens a WebSocket and resolves when it is open, or rejects with the HTTP status. */
function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('unexpected-response', (_request, response) =>
      reject(new Error(`status ${response.statusCode}`)),
    );
    socket.once('error', reject);
  });
}

function nextSnapshot(socket: WebSocket): Promise<MetricsSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no snapshot in 5 s')), 5000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      const parsed = parse(data.toString());
      if (parsed.ok) {
        resolve(parsed.value);
      } else {
        reject(new Error(parsed.error));
      }
    });
  });
}

describe('HTTP', () => {
  test('serves the sample links with no-store, as API Gateway plus the handler would', async () => {
    const response = await fetch(`${base}/api/links`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect((await getLinks()).map((link) => link.title)).toHaveLength(SEED_LINKS.length);
  });

  test('counts a click sent as the browser sends it, and the Panel API shows it', async () => {
    const [first] = await getLinks();
    const click = await fetch(`${base}/api/clicks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linkId: first?.id, channel: 'qr' }),
    });
    expect(click.status).toBe(202);

    const response = await fetch(`${base}/api/admin/metrics`, { headers: admin });
    const snapshot = (await response.json()) as MetricsSnapshot;
    expect(snapshot.totals.clicks).toBe(1);
    expect(snapshot.channels['qr']?.clicks).toBe(1);
  });

  test('refuses the admin API without the token (401)', async () => {
    const response = await fetch(`${base}/api/admin/metrics`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  test('a path parameter reaches the handler: it can edit a link by its id', async () => {
    const [first] = await getLinks();
    const response = await fetch(`${base}/api/admin/links/${first?.id}`, {
      method: 'PATCH',
      headers: { ...admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renombrado' }),
    });
    expect(response.status).toBe(200);
    expect((await getLinks())[0]?.title).toBe('Renombrado');
  });

  test('an unknown route or method is a 404', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/links`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
  });

  test('a body over 10 KB is refused by the pipeline (400)', async () => {
    const response = await fetch(`${base}/api/visits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'x'.repeat(11_000) }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { reason: string }).reason).toBe('payload_too_large');
  });

  test('a body that is not JSON is a 400, not a crash', async () => {
    const response = await fetch(`${base}/api/clicks`, { method: 'POST', body: '{oops' });
    expect(response.status).toBe(400);
  });
});

describe('WebSocket', () => {
  test('a valid ticket opens the connection, and a click arrives as a live snapshot', async () => {
    const [first] = await getLinks();
    const socket = await openSocket(`${wsBase}?ticket=${await issueTicket()}`);
    const snapshot = nextSnapshot(socket);

    await fetch(`${base}/api/clicks`, {
      method: 'POST',
      body: JSON.stringify({ linkId: first?.id }),
    });

    const received = await snapshot;
    expect(received.totals.clicks).toBe(1);
    expect(received.links[first?.id ?? '']).toBe(1);
    socket.close();
  }, 10_000);

  test('a ticket works only once: the second connection is refused with 401', async () => {
    const ticket = await issueTicket();
    const first = await openSocket(`${wsBase}?ticket=${ticket}`);
    await expect(openSocket(`${wsBase}?ticket=${ticket}`)).rejects.toThrow('status 401');
    first.close();
  });

  test('a missing or invalid ticket is refused with 401', async () => {
    await expect(openSocket(wsBase)).rejects.toThrow('status 401');
    await expect(openSocket(`${wsBase}?ticket=nope`)).rejects.toThrow('status 401');
    await expect(openSocket(`${wsBase}?ticket=${'A'.repeat(43)}`)).rejects.toThrow('status 401');
  });

  test('only the /ws path accepts a WebSocket', async () => {
    const url = `ws://127.0.0.1:${new URL(base).port}/other?ticket=${await issueTicket()}`;
    await expect(openSocket(url)).rejects.toBeDefined();
  });

  test('a keepalive from the Panel is accepted and the connection stays open', async () => {
    const socket = await openSocket(`${wsBase}?ticket=${await issueTicket()}`);
    socket.send(JSON.stringify({ type: 'keepalive' }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  test('closing the server closes the open connections too', async () => {
    const socket = await openSocket(`${wsBase}?ticket=${await issueTicket()}`);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await app.close();
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    // `afterEach` closes it again: closing twice must not hang or throw.
    app = await createLocalServer({ ownerToken: TOKEN, wsUrl: 'ws://x', seed: false });
  });
});
