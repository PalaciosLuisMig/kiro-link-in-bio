import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { ERROR_CODES, ERROR_REASONS, ErrorBody, MAX_BODY_BYTES } from '@link-in-bio/shared';

import {
  LimitReached,
  NotFound,
  ServerMisconfigured,
  Unauthorized,
  ValidationError,
} from '../domain/errors.js';
import { InMemoryOwnerTokenProvider, RecordingLogger } from '../domain/testing/fakes.js';

import { bearerToken, decodeBody, executePipeline, type RouteDefinition } from './pipeline.js';
import type { HttpRequest, HttpResponse } from './types.js';

// Unit tests for the common HTTP pipeline (task 10.1): step order, error
// translation and the guarantees that every response is `no-store` and that
// nothing sensitive reaches a response or a log entry.
//
// Validates: Requirements 5.6, 5.18, 14.1, 14.2, 14.4, 14.5, 17.3.

const TOKEN = 't'.repeat(32);
const ok: HttpResponse = { statusCode: 200, headers: { 'Cache-Control': 'no-store' } };

const BodySchema = z.object({ name: z.string() }).strict();
const ParamsSchema = z.object({ id: z.uuid() });

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { routeKey: 'POST /x', headers: {}, requestId: 'req-1', ...overrides };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function json(response: HttpResponse): unknown {
  return JSON.parse(response.body ?? 'null');
}

describe('bearerToken', () => {
  test.each([
    [{ authorization: 'Bearer abc' }, 'abc'],
    [{ authorization: 'bearer abc' }, 'abc'],
    [{ authorization: 'Bearer ' }, ''],
    [{ authorization: 'Basic abc' }, ''],
    [{ authorization: 'abc' }, ''],
    [{}, ''],
  ])('parses %j as %j', (headers, expected) => {
    expect(bearerToken(headers)).toBe(expected);
  });
});

describe('decodeBody', () => {
  test('decodes base64 bodies before measuring', () => {
    const text = '{"a":1}';
    const decoded = decodeBody(
      request({ body: Buffer.from(text).toString('base64'), isBase64Encoded: true }),
    );
    expect(decoded?.toString('utf8')).toBe(text);
  });

  test('returns undefined for an absent or empty body', () => {
    expect(decodeBody(request())).toBeUndefined();
    expect(decodeBody(request({ body: '' }))).toBeUndefined();
  });
});

describe('executePipeline', () => {
  test('size: rejects a body above the limit with 400 payload_too_large', async () => {
    let ran = false;
    const response = await executePipeline(
      request({ body: 'x'.repeat(MAX_BODY_BYTES + 1) }),
      {
        route: '/x',
        bodySchema: BodySchema,
        run: async () => {
          ran = true;
          return ok;
        },
      },
      new RecordingLogger(),
    );
    expect(response.statusCode).toBe(400);
    expect(json(response)).toEqual({
      error: ERROR_CODES.validation,
      reason: ERROR_REASONS.payloadTooLarge,
    });
    expect(ran).toBe(false);
  });

  test('size: measures the DECODED body, not the base64 text', async () => {
    const decoded = '{"name":"' + 'a'.repeat(MAX_BODY_BYTES - 20) + '"}';
    expect(Buffer.byteLength(decoded)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    const encoded = Buffer.from(decoded).toString('base64');
    expect(encoded.length).toBeGreaterThan(MAX_BODY_BYTES);
    const response = await executePipeline(
      request({ body: encoded, isBase64Encoded: true }),
      { route: '/x', bodySchema: BodySchema, run: async () => ok },
      new RecordingLogger(),
    );
    expect(response.statusCode).toBe(200);
  });

  test('size: a body of exactly the limit is accepted, one byte more is not', async () => {
    const exact = 'x'.repeat(MAX_BODY_BYTES);
    const definition: RouteDefinition = { route: '/x', run: async () => ok };
    const logger = new RecordingLogger();
    expect((await executePipeline(request({ body: exact }), definition, logger)).statusCode).toBe(
      200,
    );
    expect(
      (await executePipeline(request({ body: exact + 'x' }), definition, logger)).statusCode,
    ).toBe(400);
  });

  test('auth: a missing token gets 401 before the body is parsed', async () => {
    const response = await executePipeline(
      request({ body: 'not json' }),
      {
        route: '/x',
        ownerToken: new InMemoryOwnerTokenProvider(TOKEN),
        bodySchema: BodySchema,
        run: async () => ok,
      },
      new RecordingLogger(),
    );
    expect(response.statusCode).toBe(401);
    expect(json(response)).toEqual({ error: ERROR_CODES.unauthorized });
  });

  test('auth: a short configured token gives 500, ahead of the 401', async () => {
    const response = await executePipeline(
      request({ headers: bearer('wrong') }),
      { route: '/x', ownerToken: new InMemoryOwnerTokenProvider('short'), run: async () => ok },
      new RecordingLogger(),
    );
    expect(response.statusCode).toBe(500);
    expect(json(response)).toEqual({ error: ERROR_CODES.serverError });
  });

  test('auth: the right token reaches the use case', async () => {
    const response = await executePipeline(
      request({ headers: bearer(TOKEN) }),
      { route: '/x', ownerToken: new InMemoryOwnerTokenProvider(TOKEN), run: async () => ok },
      new RecordingLogger(),
    );
    expect(response.statusCode).toBe(200);
  });

  test('JSON: an invalid or missing body is 400 validation on `body`', async () => {
    const definition: RouteDefinition<{ name: string }> = {
      route: '/x',
      bodySchema: BodySchema,
      run: async () => ok,
    };
    const logger = new RecordingLogger();
    for (const body of ['{oops', undefined]) {
      const response = await executePipeline(request({ body }), definition, logger);
      expect(response.statusCode).toBe(400);
      expect(json(response)).toEqual({
        error: ERROR_CODES.validation,
        fields: [{ path: 'body', message: 'invalid value' }],
      });
    }
  });

  test('schema: lists only paths and static messages, never values', async () => {
    const response = await executePipeline(
      request({ body: JSON.stringify({ name: 42, secret: 'hunter2' }) }),
      { route: '/x', bodySchema: BodySchema, run: async () => ok },
      new RecordingLogger(),
    );
    expect(response.statusCode).toBe(400);
    expect(json(response)).toEqual({
      error: ERROR_CODES.validation,
      fields: [
        { path: 'name', message: 'invalid type' },
        { path: 'body', message: 'unexpected field' },
      ],
    });
    expect(response.body).not.toContain('hunter2');
  });

  test('schema: validates path parameters', async () => {
    const response = await executePipeline(
      request({ pathParameters: { id: 'nope' } }),
      { route: '/x', paramsSchema: ParamsSchema, run: async () => ok },
      new RecordingLogger(),
    );
    expect(response.statusCode).toBe(400);
    expect(json(response)).toEqual({
      error: ERROR_CODES.validation,
      fields: [{ path: 'id', message: 'invalid format' }],
    });
  });

  test('run: receives the parsed body and params', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    let received: unknown;
    await executePipeline(
      request({ body: '{"name":"a"}', pathParameters: { id } }),
      {
        route: '/x',
        bodySchema: BodySchema,
        paramsSchema: ParamsSchema,
        run: async (input) => {
          received = input;
          return ok;
        },
      },
      new RecordingLogger(),
    );
    expect(received).toEqual({ body: { name: 'a' }, params: { id } });
  });

  test.each([
    [new NotFound(), 404, ERROR_CODES.notFound],
    [new LimitReached(), 409, ERROR_CODES.limitReached],
    [new ValidationError('x', ['ids']), 400, ERROR_CODES.validation],
    [new ServerMisconfigured(), 500, ERROR_CODES.serverError],
  ])('translates %s', async (error, status, code) => {
    const response = await executePipeline(
      request(),
      {
        route: '/x',
        run: async () => {
          throw error;
        },
      },
      new RecordingLogger(),
    );
    expect(response.statusCode).toBe(status);
    expect((json(response) as { error: string }).error).toBe(code);
  });

  test('a ValidationError carries its reason into the response', async () => {
    const response = await executePipeline(
      request(),
      {
        route: '/x',
        run: async () => {
          throw new ValidationError('bad order', ['ids'], ERROR_REASONS.idsNotPermutation);
        },
      },
      new RecordingLogger(),
    );
    expect(json(response)).toEqual({
      error: ERROR_CODES.validation,
      fields: [{ path: 'ids', message: 'invalid value' }],
      reason: ERROR_REASONS.idsNotPermutation,
    });
  });

  test('Unauthorized and ServerMisconfigured never carry a reason or fields', async () => {
    for (const error of [new Unauthorized(), new ServerMisconfigured()]) {
      const response = await executePipeline(
        request(),
        {
          route: '/x',
          run: async () => {
            throw error;
          },
        },
        new RecordingLogger(),
      );
      expect(Object.keys(json(response) as object)).toEqual(['error']);
    }
  });

  test('a ValidationError carries its field names into the response', async () => {
    const response = await executePipeline(
      request(),
      {
        route: '/x',
        run: async () => {
          throw new ValidationError('bad order', ['ids']);
        },
      },
      new RecordingLogger(),
    );
    expect(json(response)).toEqual({
      error: ERROR_CODES.validation,
      fields: [{ path: 'ids', message: 'invalid value' }],
    });
  });

  test('an unexpected error is a bare 500 and logs only code, route and request id', async () => {
    const logger = new RecordingLogger();
    const response = await executePipeline(
      request({ headers: bearer(TOKEN), body: '{"secret":"hunter2"}' }),
      {
        route: '/x',
        run: async () => {
          throw new Error('db exploded: hunter2');
        },
      },
      logger,
    );
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(JSON.stringify({ error: ERROR_CODES.serverError }));
    expect(logger.errors).toEqual([
      {
        message: 'request_failed',
        context: { code: ERROR_CODES.serverError, route: '/x', requestId: 'req-1' },
      },
    ]);
    expect(JSON.stringify(logger)).not.toContain('hunter2');
  });

  test('every error response is no-store and has no CORS headers', async () => {
    const response = await executePipeline(
      request({ body: 'x'.repeat(MAX_BODY_BYTES + 1) }),
      { route: '/x', run: async () => ok },
      new RecordingLogger(),
    );
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(Object.keys(response.headers).some((h) => /^access-control-/i.test(h))).toBe(false);
  });

  test('every error body matches the shared ErrorBody contract', async () => {
    const logger = new RecordingLogger();
    const owner = new InMemoryOwnerTokenProvider(TOKEN);
    const cases: [HttpRequest, RouteDefinition<{ name: string }>][] = [
      [
        request({ body: 'x'.repeat(MAX_BODY_BYTES + 1) }),
        { route: '/x', bodySchema: BodySchema, run: async () => ok },
      ],
      [request({ body: '{oops' }), { route: '/x', bodySchema: BodySchema, run: async () => ok }],
      [
        request({ body: '{"name":1}' }),
        { route: '/x', bodySchema: BodySchema, run: async () => ok },
      ],
      [request(), { route: '/x', ownerToken: owner, run: async () => ok }],
      [
        request(),
        {
          route: '/x',
          run: async () => {
            throw new NotFound();
          },
        },
      ],
      [
        request(),
        {
          route: '/x',
          run: async () => {
            throw new Error('boom');
          },
        },
      ],
    ];
    for (const [req, definition] of cases) {
      const response = await executePipeline(req, definition, logger);
      expect(ErrorBody.safeParse(json(response)).success).toBe(true);
    }
  });
});
