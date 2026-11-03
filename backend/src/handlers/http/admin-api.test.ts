import { beforeEach, describe, expect, test } from 'vitest';

import { API_ROUTES, ENV_VARS, ERROR_CODES, ERROR_REASONS, MAX_LINKS } from '@link-in-bio/shared';

import {
  DeterministicRandomSource,
  FakeClock,
  InMemoryEventRepository,
  InMemoryLinkRepository,
  InMemoryMetricsRepository,
  InMemoryOwnerTokenProvider,
  InMemoryRealtimeAccessRepository,
  RecordingLogger,
} from '../../lib/domain/testing/fakes.js';
import type { IdGenerator } from '../../lib/domain/ports.js';
import type { HttpRequest, HttpResponse } from '../../lib/http/types.js';

import { composeAdminApi } from './admin-api-composition.js';
import { handleAdminRequest, type AdminApiDeps } from './admin-api-routes.js';

// Tests of the admin API handlers with in-memory doubles (task 10.5): the codes
// of the design's error table (400, 401, 404, 409, 500) and a "canary" token
// that must appear in no response and no log entry.
//
// Validates: Requirements 5.3, 5.18, 6.9, 6.12, 11.2, 14.2.

const TOKEN = 'canary-' + 'c'.repeat(40);
const WS_URL = 'wss://example.test/prod';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

/** Sequential ids that are valid UUIDs, since the admin schemas require them. */
class SequentialUuidGenerator implements IdGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `11111111-1111-4111-8111-${String(this.counter).padStart(12, '0')}`;
  }
}

interface Fixture {
  readonly deps: AdminApiDeps;
  readonly links: InMemoryLinkRepository;
  readonly metrics: InMemoryMetricsRepository;
  readonly logger: RecordingLogger;
  readonly owner: InMemoryOwnerTokenProvider;
}

function fixture(): Fixture {
  const metrics = new InMemoryMetricsRepository();
  const links = new InMemoryLinkRepository((id) => metrics.clicksOf(id));
  const logger = new RecordingLogger();
  const owner = new InMemoryOwnerTokenProvider(TOKEN);
  const deps: AdminApiDeps = {
    links,
    metrics,
    events: new InMemoryEventRepository(),
    realtime: new InMemoryRealtimeAccessRepository(),
    ownerToken: owner,
    clock: new FakeClock(1_700_000_000_000),
    ids: new SequentialUuidGenerator(),
    random: new DeterministicRandomSource(),
    logger,
    wsUrl: WS_URL,
  };
  return { deps, links, metrics, logger, owner };
}

function req(
  method: string,
  template: string,
  options: { body?: unknown; id?: string; token?: string | null } = {},
): HttpRequest {
  const token = options.token === undefined ? TOKEN : options.token;
  return {
    routeKey: `${method} ${template}`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body:
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body),
    pathParameters: options.id === undefined ? undefined : { id: options.id },
    requestId: 'req-1',
  };
}

function json<T = Record<string, unknown>>(response: HttpResponse): T {
  return JSON.parse(response.body ?? '{}') as T;
}

describe('admin API', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });

  async function create(title: string, url = 'https://ejemplo.com'): Promise<string> {
    const response = await handleAdminRequest(
      f.deps,
      req('POST', API_ROUTES.adminLinks, { body: { title, url } }),
    );
    expect(response.statusCode).toBe(201);
    return json<{ id: string }>(response).id;
  }

  test('every admin route answers 401 without a valid token', async () => {
    const routes: [string, string, string?][] = [
      ['POST', API_ROUTES.realtimeTickets],
      ['GET', API_ROUTES.metrics],
      ['POST', API_ROUTES.metricsReset],
      ['GET', API_ROUTES.adminLinks],
      ['POST', API_ROUTES.adminLinks],
      ['PATCH', API_ROUTES.adminLink, UNKNOWN_ID],
      ['DELETE', API_ROUTES.adminLink, UNKNOWN_ID],
      ['PUT', API_ROUTES.adminLinksOrder],
    ];
    for (const [method, template, id] of routes) {
      for (const token of [null, '', 'wrong']) {
        const response = await handleAdminRequest(
          f.deps,
          req(method, template, { token, ...(id !== undefined ? { id } : {}) }),
        );
        expect(response.statusCode).toBe(401);
        expect(json(response)).toEqual({ error: ERROR_CODES.unauthorized });
      }
    }
  });

  test('a short configured token makes every request a 500', async () => {
    f.owner.set('short');
    const response = await handleAdminRequest(f.deps, req('GET', API_ROUTES.metrics));
    expect(response.statusCode).toBe(500);
    expect(json(response)).toEqual({ error: ERROR_CODES.serverError });
  });

  test('POST realtime-tickets returns ticket, expiry and wsUrl', async () => {
    const response = await handleAdminRequest(f.deps, req('POST', API_ROUTES.realtimeTickets));
    expect(response.statusCode).toBe(200);
    const body = json<{ ticket: string; expiresAt: number; wsUrl: string }>(response);
    expect(body.wsUrl).toBe(WS_URL);
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe(1_700_000_000_000 + 60_000);
  });

  test('GET metrics returns a snapshot; reset returns the new epoch', async () => {
    const snapshot = await handleAdminRequest(f.deps, req('GET', API_ROUTES.metrics));
    expect(snapshot.statusCode).toBe(200);
    expect(json(snapshot)).toMatchObject({ epoch: 0, totals: { clicks: 0, visits: 0 } });

    const reset = await handleAdminRequest(f.deps, req('POST', API_ROUTES.metricsReset));
    expect(reset.statusCode).toBe(200);
    expect(json(reset)).toEqual({ epoch: 1_700_000_000_000 });
  });

  test('links: create (201), list, patch (200), delete (204)', async () => {
    const id = await create('  Mi web  ');

    const list = await handleAdminRequest(f.deps, req('GET', API_ROUTES.adminLinks));
    expect(json(list)).toEqual({
      links: [
        { id, title: 'Mi web', url: 'https://ejemplo.com', active: true, position: 0, clicks: 0 },
      ],
    });

    const patch = await handleAdminRequest(
      f.deps,
      req('PATCH', API_ROUTES.adminLink, { id, body: { active: false } }),
    );
    expect(patch.statusCode).toBe(200);
    expect(json(patch)).toMatchObject({ id, active: false });

    const del = await handleAdminRequest(f.deps, req('DELETE', API_ROUTES.adminLink, { id }));
    expect(del.statusCode).toBe(204);
    expect(del.body).toBeUndefined();
    expect(del.headers['Cache-Control']).toBe('no-store');
  });

  test('create: invalid body and extra fields are 400 validation', async () => {
    for (const body of [
      { title: '', url: 'https://a.com' },
      { title: 'ok', url: 'javascript:alert(1)' },
      { title: 'ok', url: 'https://a.com', extra: 1 },
      '{oops',
    ]) {
      const response = await handleAdminRequest(
        f.deps,
        req('POST', API_ROUTES.adminLinks, { body }),
      );
      expect(response.statusCode).toBe(400);
      expect(json<{ error: string }>(response).error).toBe(ERROR_CODES.validation);
    }
  });

  test('create: the 11th link is 409 limit_reached', async () => {
    for (let i = 0; i < MAX_LINKS; i += 1) {
      await create(`Enlace ${i}`);
    }
    const response = await handleAdminRequest(
      f.deps,
      req('POST', API_ROUTES.adminLinks, { body: { title: 'Uno más', url: 'https://a.com' } }),
    );
    expect(response.statusCode).toBe(409);
    expect(json(response)).toEqual({ error: ERROR_CODES.limitReached });
  });

  test('patch and delete: a malformed id is 400, an unknown id is 404', async () => {
    for (const method of ['PATCH', 'DELETE']) {
      const bad = await handleAdminRequest(
        f.deps,
        req(method, API_ROUTES.adminLink, { id: 'nope', body: { active: true } }),
      );
      expect(bad.statusCode).toBe(400);
      expect(json(bad)).toEqual({
        error: ERROR_CODES.validation,
        fields: [{ path: 'id', message: 'invalid format' }],
      });

      const missing = await handleAdminRequest(
        f.deps,
        req(method, API_ROUTES.adminLink, { id: UNKNOWN_ID, body: { active: true } }),
      );
      expect(missing.statusCode).toBe(404);
      expect(json(missing)).toEqual({ error: ERROR_CODES.notFound });
    }
  });

  test('patch: an empty or extra-field body is 400', async () => {
    const id = await create('Mi web');
    for (const body of [{}, { nope: 1 }]) {
      const response = await handleAdminRequest(
        f.deps,
        req('PATCH', API_ROUTES.adminLink, { id, body }),
      );
      expect(response.statusCode).toBe(400);
    }
  });

  test('order: an exact permutation reorders, anything else is 400', async () => {
    const a = await create('A');
    const b = await create('B');

    const ok = await handleAdminRequest(
      f.deps,
      req('PUT', API_ROUTES.adminLinksOrder, { body: { ids: [b, a] } }),
    );
    expect(ok.statusCode).toBe(200);
    expect(json<{ links: { id: string }[] }>(ok).links.map((l) => l.id)).toEqual([b, a]);

    for (const ids of [[a], [a, a], [a, UNKNOWN_ID]]) {
      const bad = await handleAdminRequest(
        f.deps,
        req('PUT', API_ROUTES.adminLinksOrder, { body: { ids } }),
      );
      expect(bad.statusCode).toBe(400);
      expect(json(bad)).toEqual({
        error: ERROR_CODES.validation,
        fields: [{ path: 'ids', message: 'invalid value' }],
        reason: ERROR_REASONS.idsNotPermutation,
      });
    }
  });

  test('an unexpected failure is a bare 500', async () => {
    f.links.list = async () => {
      throw new Error('dynamo down');
    };
    const response = await handleAdminRequest(f.deps, req('GET', API_ROUTES.adminLinks));
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(JSON.stringify({ error: ERROR_CODES.serverError }));
  });

  test('canary: the token, bodies and headers appear in no response and no log', async () => {
    const secretTitle = 'titulo-secreto-12345';
    const responses: HttpResponse[] = [];
    const id = await create(secretTitle);
    responses.push(
      await handleAdminRequest(
        f.deps,
        req('GET', API_ROUTES.adminLinks, { token: 'wrong-canary' }),
      ),
      await handleAdminRequest(
        f.deps,
        req('PATCH', API_ROUTES.adminLink, { id, body: { title: '' } }),
      ),
      await handleAdminRequest(
        f.deps,
        req('POST', API_ROUTES.adminLinks, { body: '{"leak":"body-canary-777"' }),
      ),
    );
    f.links.list = async () => {
      throw new Error(`boom ${TOKEN} body-canary-777`);
    };
    responses.push(await handleAdminRequest(f.deps, req('GET', API_ROUTES.adminLinks)));

    const everything = JSON.stringify([responses, f.logger]);
    for (const secret of [TOKEN, 'wrong-canary', 'body-canary-777']) {
      expect(everything).not.toContain(secret);
    }
    // Error responses never echo link data; only the success paths do.
    expect(JSON.stringify(responses.slice(1))).not.toContain(secretTitle);
  });
});

describe('composeAdminApi', () => {
  const full = {
    [ENV_VARS.tableName]: 'LinkInBioTable',
    [ENV_VARS.ownerTokenParameter]: '/link-in-bio/owner-token',
    [ENV_VARS.wsUrl]: WS_URL,
  };

  test.each([ENV_VARS.tableName, ENV_VARS.ownerTokenParameter, ENV_VARS.wsUrl])(
    'fails fast naming %s when it is missing',
    (name) => {
      expect(() => composeAdminApi({ ...full, [name]: undefined })).toThrow(name);
    },
  );

  test('builds the dependencies when everything is set', () => {
    const deps = composeAdminApi(full);
    expect(deps.wsUrl).toBe(WS_URL);
  });
});
