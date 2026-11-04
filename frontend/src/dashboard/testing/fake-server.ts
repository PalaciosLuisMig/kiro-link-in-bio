// A fake of the admin API and of the WebSocket, for the Panel tests. It follows the
// rules of the real API that the Panel depends on: the token check, the limit of
// 10 links, a 404 for an unknown id, the exact-permutation rule of a reorder and
// the error body `{ error, reason }`.

import type { AdminLink, MetricsSnapshot } from '@link-in-bio/shared';

import type { FetchLike } from '../../lib/api.js';
import type { WebSocketLike } from '../realtime.js';

export const OWNER_TOKEN = 'o'.repeat(40);
export const WS_URL = 'wss://example.test/prod';

export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

/** What a failing route does: answer with a status, fail the network, or never answer. */
export type Failure = number | 'network' | 'hang';

export function emptySnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    epoch: 0,
    serverTime: new Date(Date.now()).toISOString(),
    totals: { clicks: 0, visits: 0 },
    links: {},
    minutes: {},
    channels: {},
    events: [],
    ...overrides,
  };
}

export function link(n: number, overrides: Partial<AdminLink> = {}): AdminLink {
  return {
    id: `link-${n}`,
    title: `Enlace ${n}`,
    url: `https://ejemplo.com/${n}`,
    active: true,
    position: n - 1,
    clicks: 0,
    ...overrides,
  };
}

/** `METHOD /path`, with every single-link path written as `/api/admin/links/:id`. */
function routeKey(method: string, path: string): string {
  const isSingleLink = path.startsWith('/api/admin/links/') && path !== '/api/admin/links/order';
  return `${method} ${isSingleLink ? '/api/admin/links/:id' : path}`;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

export class FakeServer {
  token = OWNER_TOKEN;
  links: AdminLink[] = [];
  snapshot: MetricsSnapshot = emptySnapshot();
  readonly calls: RecordedCall[] = [];
  private readonly failures = new Map<string, { failure: Failure; once: boolean }>();
  private nextId = 100;
  private ticketCount = 0;

  /**
   * Makes a route fail. `route` is `METHOD /path`, with `/api/admin/links/:id` for a
   * single link. It fails once by default, or on every call with `once = false`.
   */
  fail(route: string, failure: Failure, once = true): void {
    this.failures.set(route, { failure, once });
  }

  clearFailures(): void {
    this.failures.clear();
  }

  /** Calls to a route, e.g. `callsTo('GET', '/api/admin/metrics')`. */
  callsTo(method: string, path: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method && call.path === path);
  }

  readonly fetch: FetchLike = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? init.body : undefined;
    this.calls.push({ method, path, headers, body });

    const key = routeKey(method, path);
    const planned = this.failures.get(key);
    if (planned !== undefined) {
      if (planned.once) {
        this.failures.delete(key);
      }
      if (planned.failure === 'network') {
        throw new TypeError('offline');
      }
      if (planned.failure === 'hang') {
        return new Promise<Response>(() => {});
      }
      return json({ error: 'server_error' }, planned.failure);
    }

    if (headers['Authorization'] !== `Bearer ${this.token}`) {
      return json({ error: 'unauthorized' }, 401);
    }
    return this.route(method, path, body);
  };

  private route(method: string, path: string, rawBody: string | undefined): Response {
    const body = rawBody === undefined ? {} : (JSON.parse(rawBody) as Record<string, unknown>);

    if (method === 'GET' && path === '/api/admin/links') {
      return json({ links: this.sorted() });
    }
    if (method === 'GET' && path === '/api/admin/metrics') {
      return json(this.snapshot);
    }
    if (method === 'POST' && path === '/api/admin/realtime-tickets') {
      this.ticketCount += 1;
      return json({ ticket: `ticket-${this.ticketCount}`, expiresAt: 0, wsUrl: WS_URL });
    }
    if (method === 'POST' && path === '/api/admin/metrics/reset') {
      const epoch = this.snapshot.epoch + 1000;
      this.snapshot = emptySnapshot({ epoch });
      return json({ epoch });
    }
    if (method === 'POST' && path === '/api/admin/links') {
      if (this.links.length >= 10) {
        return json({ error: 'limit_reached' }, 409);
      }
      if (
        typeof body.title !== 'string' ||
        body.title.trim() === '' ||
        typeof body.url !== 'string'
      ) {
        return json({ error: 'validation' }, 400);
      }
      const created: AdminLink = {
        id: `link-${this.nextId++}`,
        title: body.title.trim(),
        url: body.url,
        active: true,
        position: this.links.length,
        clicks: 0,
      };
      this.links.push(created);
      return json(created, 201);
    }
    if (method === 'PUT' && path === '/api/admin/links/order') {
      const ids = (body.ids ?? []) as string[];
      const current = this.links.map((l) => l.id).sort();
      if (JSON.stringify([...ids].sort()) !== JSON.stringify(current)) {
        return json({ error: 'validation', reason: 'ids_not_permutation' }, 400);
      }
      this.links = ids.map((id, position) => ({
        ...(this.links.find((l) => l.id === id) as AdminLink),
        position,
      }));
      return json({ links: this.sorted() });
    }

    const match = /^\/api\/admin\/links\/(.+)$/.exec(path);
    if (match !== null) {
      const id = decodeURIComponent(match[1] as string);
      const index = this.links.findIndex((l) => l.id === id);
      if (index < 0) {
        return json({ error: 'not_found' }, 404);
      }
      if (method === 'DELETE') {
        this.links.splice(index, 1);
        this.links = this.links.map((l, position) => ({ ...l, position }));
        return new Response(null, { status: 204 });
      }
      if (method === 'PATCH') {
        const current = this.links[index] as AdminLink;
        const updated: AdminLink = {
          ...current,
          ...(typeof body.title === 'string' ? { title: body.title.trim() } : {}),
          ...(typeof body.url === 'string' ? { url: body.url } : {}),
          ...(typeof body.active === 'boolean' ? { active: body.active } : {}),
        };
        this.links[index] = updated;
        return json(updated);
      }
    }
    return json({ error: 'not_found' }, 404);
  }

  private sorted(): AdminLink[] {
    return [...this.links].sort((a, b) => a.position - b.position);
  }
}

/** A fake WebSocket: the test opens it, feeds it messages and drops it. */
export class FakeSocket implements WebSocketLike {
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

  drop(): void {
    this.onclose?.({});
  }
}
