import fc from 'fast-check';
import { beforeEach, describe, expect, test } from 'vitest';

import {
  API_ROUTES,
  ENV_VARS,
  ERROR_CODES,
  ERROR_REASONS,
  MAX_BODY_BYTES,
} from '@link-in-bio/shared';

import {
  FakeClock,
  InMemoryEventRepository,
  InMemoryLinkRepository,
  InMemoryMetricsRepository,
  RecordingLogger,
  SequentialIdGenerator,
} from '../../lib/domain/testing/fakes.js';
import type { HttpRequest, HttpResponse } from '../../lib/http/types.js';

import { composePublicApi } from './public-api-composition.js';
import { handlePublicRequest, type PublicApiDeps } from './public-api-routes.js';

// Tests of the public API handlers with in-memory doubles (task 10.5):
// status codes of the design's error table, and Property 18 (part 2): arbitrary
// IP / User-Agent / Referer headers never reach the stored data or the logs.
//
// Validates: Requirements 1.3, 2.5, 2.6, 2.7, 3.2, 11.1, 11.2, 14.1, 14.2.

const numRuns = Number(process.env.FC_NUM_RUNS ?? '100');

const ACTIVE_ID = '11111111-1111-4111-8111-111111111111';
const INACTIVE_ID = '22222222-2222-4222-8222-222222222222';

interface Fixture {
  readonly deps: PublicApiDeps;
  readonly metrics: InMemoryMetricsRepository;
  readonly events: InMemoryEventRepository;
  readonly logger: RecordingLogger;
}

function fixture(): Fixture {
  const metrics = new InMemoryMetricsRepository();
  const links = new InMemoryLinkRepository((id) => metrics.clicksOf(id));
  links.seed({
    id: ACTIVE_ID,
    title: 'Mi web',
    url: 'https://ejemplo.com',
    position: 0,
    active: true,
    createdAt: 1,
  });
  links.seed({
    id: INACTIVE_ID,
    title: 'Oculto',
    url: 'https://oculto.example',
    position: 1,
    active: false,
    createdAt: 2,
  });
  const events = new InMemoryEventRepository();
  const logger = new RecordingLogger();
  const deps: PublicApiDeps = {
    links,
    metrics,
    events,
    clock: new FakeClock(1_700_000_000_000),
    ids: new SequentialIdGenerator('evt'),
    logger,
  };
  return { deps, metrics, events, logger };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): HttpRequest {
  return {
    routeKey: `POST ${path}`,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    requestId: 'req-1',
  };
}

function code(response: HttpResponse): unknown {
  return (JSON.parse(response.body ?? '{}') as { error?: string }).error;
}

describe('public API', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });

  test('GET /api/links returns only active links as {id,title,url}', async () => {
    const response = await handlePublicRequest(f.deps, {
      routeKey: `GET ${API_ROUTES.publicLinks}`,
      headers: {},
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? '')).toEqual({
      links: [{ id: ACTIVE_ID, title: 'Mi web', url: 'https://ejemplo.com' }],
    });
    expect(response.headers['Cache-Control']).toBe('no-store');
  });

  test('POST /api/clicks answers 202 {} and counts the click', async () => {
    const response = await handlePublicRequest(
      f.deps,
      post(API_ROUTES.clicks, { linkId: ACTIVE_ID, channel: 'Instagram' }),
    );
    expect(response.statusCode).toBe(202);
    expect(response.body).toBe('{}');
    expect(f.metrics.clicksOf(ACTIVE_ID)).toBe(1);
    expect(f.events.size).toBe(1);
  });

  test('POST /api/clicks on an unknown or inactive link is 404', async () => {
    for (const linkId of [INACTIVE_ID, '33333333-3333-4333-8333-333333333333']) {
      const response = await handlePublicRequest(f.deps, post(API_ROUTES.clicks, { linkId }));
      expect(response.statusCode).toBe(404);
      expect(code(response)).toBe(ERROR_CODES.notFound);
    }
    expect(f.events.size).toBe(0);
  });

  test('POST /api/clicks with an invalid body is 400 validation', async () => {
    for (const body of [
      '{oops',
      { linkId: 'nope' },
      {},
      { linkId: ACTIVE_ID, channel: 'x'.repeat(257) },
    ]) {
      const response = await handlePublicRequest(f.deps, post(API_ROUTES.clicks, body));
      expect(response.statusCode).toBe(400);
      expect(code(response)).toBe(ERROR_CODES.validation);
    }
  });

  test('POST /api/clicks ignores extra fields instead of rejecting them', async () => {
    const response = await handlePublicRequest(
      f.deps,
      post(API_ROUTES.clicks, { linkId: ACTIVE_ID, ip: '1.2.3.4' }),
    );
    expect(response.statusCode).toBe(202);
  });

  test('POST /api/visits answers 202 {} and counts the visit', async () => {
    const response = await handlePublicRequest(f.deps, post(API_ROUTES.visits, { channel: 'qr' }));
    expect(response.statusCode).toBe(202);
    const item = await f.metrics.read();
    expect(item['totalVisits']).toBe(1);
    expect(item['cv#qr']).toBe(1);
  });

  test('a body above 10 240 bytes is 400 payload_too_large', async () => {
    const response = await handlePublicRequest(
      f.deps,
      post(API_ROUTES.visits, 'x'.repeat(MAX_BODY_BYTES + 1)),
    );
    expect(response.statusCode).toBe(400);
    expect(code(response)).toBe(ERROR_CODES.validation);
    expect(JSON.parse(response.body ?? '{}')).toMatchObject({
      reason: ERROR_REASONS.payloadTooLarge,
    });
  });

  test('a failing increment is a bare 500 server_error', async () => {
    f.deps.metrics.recordClick = async () => {
      throw new Error('dynamo down');
    };
    const response = await handlePublicRequest(
      f.deps,
      post(API_ROUTES.clicks, { linkId: ACTIVE_ID }),
    );
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(JSON.stringify({ error: ERROR_CODES.serverError }));
    expect(f.events.size).toBe(0);
  });

  test('a failing event write still answers 202', async () => {
    f.events.putFailure.arm();
    const response = await handlePublicRequest(
      f.deps,
      post(API_ROUTES.clicks, { linkId: ACTIVE_ID }),
    );
    expect(response.statusCode).toBe(202);
    expect(f.logger.errors).toHaveLength(1);
  });

  test('an unknown route is 404', async () => {
    const response = await handlePublicRequest(f.deps, { routeKey: 'GET /nope', headers: {} });
    expect(response.statusCode).toBe(404);
  });

  // Feature: link-in-bio, Property 18 (part 2): only allowed data is stored.
  test('Property 18: arbitrary IP, User-Agent and Referer never reach stored data or logs', async () => {
    const allowedEventKeys = new Set(['id', 'type', 'channel', 'title', 'ts']);
    const allowedMetricKey = /^(totalClicks|totalVisits|epoch|l#.+|cc#.+|cv#.+|m#\d+)$/;

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 40 }),
        fc.string({ minLength: 8, maxLength: 40 }),
        fc.string({ minLength: 8, maxLength: 40 }),
        fc.boolean(),
        async (ip, userAgent, referer, isClick) => {
          const run = fixture();
          const headers = {
            'x-forwarded-for': `ip:${ip}`,
            'user-agent': `ua:${userAgent}`,
            referer: `ref:${referer}`,
          };
          const response = await handlePublicRequest(
            run.deps,
            isClick
              ? post(API_ROUTES.clicks, { linkId: ACTIVE_ID, channel: 'qr' }, headers)
              : post(API_ROUTES.visits, { channel: 'qr' }, headers),
          );
          expect(response.statusCode).toBe(202);

          const events = await run.events.latest('0', 20);
          expect(events).toHaveLength(1);
          for (const event of events) {
            for (const key of Object.keys(event)) {
              expect(allowedEventKeys.has(key)).toBe(true);
            }
          }
          for (const key of Object.keys(await run.metrics.read())) {
            expect(key).toMatch(allowedMetricKey);
          }

          const everything = JSON.stringify([events, await run.metrics.read(), run.logger]);
          for (const value of [`ip:${ip}`, `ua:${userAgent}`, `ref:${referer}`]) {
            expect(everything).not.toContain(value);
          }
        },
      ),
      { numRuns },
    );
  });
});

describe('composePublicApi', () => {
  test('fails fast naming the missing variable', () => {
    expect(() => composePublicApi({})).toThrow(ENV_VARS.tableName);
    expect(() => composePublicApi({ [ENV_VARS.tableName]: '' })).toThrow(ENV_VARS.tableName);
  });

  test('builds the dependencies when the table name is set', () => {
    const deps = composePublicApi({ [ENV_VARS.tableName]: 'LinkInBioTable' });
    expect(deps.links).toBeDefined();
    expect(deps.logger).toBeDefined();
  });
});
