import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { ERROR_CODES } from '@link-in-bio/shared';

import { authorizeOwner } from '../domain/authorize-owner.js';
import { Unauthorized } from '../domain/errors.js';
import { InMemoryOwnerTokenProvider, RecordingLogger } from '../domain/testing/fakes.js';

import { executePipeline } from './pipeline.js';
import type { HttpRequest } from './types.js';

// Feature: link-in-bio, Property 17: Autorización
//
// For any token other than the owner token, including the empty one,
// `authorizeOwner` fails. For any admin request without a valid token, the
// pipeline answers 401 without evaluating the body schema: an anonymous caller
// with an invalid body gets 401, not a schema error.
//
// Validates: Requirements 5.3, 5.6.

const numRuns = Number(process.env.FC_NUM_RUNS ?? '100');

const OWNER_TOKEN = 'o'.repeat(24) + 'W'.repeat(24);
const BodySchema = z.object({ title: z.string() }).strict();

const wrongToken = fc
  .oneof(
    fc.constant(''),
    fc.string({ maxLength: 80 }),
    fc.string({ minLength: 1, maxLength: 80 }).map((suffix) => OWNER_TOKEN + suffix),
    fc.constant(OWNER_TOKEN.slice(1)),
    fc.constant(OWNER_TOKEN.toUpperCase()),
  )
  .filter((token) => token !== OWNER_TOKEN);

// Any text: valid JSON, invalid JSON, schema-invalid JSON, or no body at all.
const anyBody = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.json(),
  fc.constant('{"title":123}'),
  fc.constant('{"unexpected":true}'),
  fc.constant(undefined),
);

describe('Property 17: authorization', () => {
  test('authorizeOwner rejects every token that is not the owner token', async () => {
    await fc.assert(
      fc.asyncProperty(wrongToken, async (token) => {
        await expect(
          authorizeOwner(new InMemoryOwnerTokenProvider(OWNER_TOKEN), token),
        ).rejects.toBeInstanceOf(Unauthorized);
      }),
      { numRuns },
    );
  });

  test('the pipeline answers 401 for any wrong token, whatever the body', async () => {
    await fc.assert(
      fc.asyncProperty(wrongToken, anyBody, fc.boolean(), async (token, body, sendHeader) => {
        let schemaOrRunReached = false;
        const request: HttpRequest = {
          routeKey: 'POST /api/admin/links',
          headers: sendHeader ? { authorization: `Bearer ${token}` } : {},
          body,
        };
        const response = await executePipeline(
          request,
          {
            route: '/api/admin/links',
            ownerToken: new InMemoryOwnerTokenProvider(OWNER_TOKEN),
            bodySchema: {
              safeParse(input) {
                schemaOrRunReached = true;
                return BodySchema.safeParse(input);
              },
            },
            run: async () => {
              schemaOrRunReached = true;
              return { statusCode: 200, headers: {} };
            },
          },
          new RecordingLogger(),
        );
        // The size check comes first by design, but `anyBody` stays far below it.
        expect(response.statusCode).toBe(401);
        expect(JSON.parse(response.body ?? '{}')).toEqual({ error: ERROR_CODES.unauthorized });
        expect(schemaOrRunReached).toBe(false);
      }),
      { numRuns },
    );
  });
});
