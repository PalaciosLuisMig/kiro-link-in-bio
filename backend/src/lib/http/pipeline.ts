// Common HTTP pipeline shared by every API handler (Requirements 5.6, 14.1).
//
// Order of the steps, fixed by the design:
//   1. size    decoded body above 10 240 bytes -> 400 `validation`, reason `payload_too_large`
//   2. auth    admin routes only: `authorizeOwner` with the Bearer token
//   3. JSON    body that is not valid JSON -> 400 `validation`
//   4. schema  body and path parameters against their schema -> 400 `validation`
//   5. use case, whose domain errors are translated to HTTP
//
// A request without a valid token never reaches steps 3-4, so an anonymous
// caller cannot learn the shape of the admin API (Property 17). Logging goes
// through the `Logger` port with only `code`, `route` and `requestId`: no body,
// header, token or ticket is ever read into a log entry (Requirements 5.18,
// 11.2).

import { ERROR_CODES, ERROR_REASONS, MAX_BODY_BYTES, type ErrorField } from '@link-in-bio/shared';

import { isDomainError, ValidationError } from '../domain/errors.js';
import { authorizeOwner } from '../domain/authorize-owner.js';
import type { Logger, OwnerTokenProvider } from '../domain/ports.js';

import { errorResponse } from './responses.js';
import type { HttpRequest, HttpResponse, Schema, SchemaIssue } from './types.js';

/** What a route's `run` receives once every earlier step has passed. */
export interface RouteInput<B, P> {
  readonly body: B;
  readonly params: P;
}

/**
 * One route. `B` and `P` are `undefined` for a route with no body schema or no
 * path-parameter schema; such a route ignores the body (its size is still
 * checked).
 */
export interface RouteDefinition<B = undefined, P = undefined> {
  /** Route template for logs, e.g. `/api/clicks`. Never a URL with a query. */
  readonly route: string;
  /** Present on admin routes: the provider of the configured owner token. */
  readonly ownerToken?: OwnerTokenProvider;
  readonly bodySchema?: Schema<B>;
  readonly paramsSchema?: Schema<P>;
  readonly run: (input: RouteInput<B, P>) => Promise<HttpResponse>;
}

/** Decodes the body honouring `isBase64Encoded`; `undefined` when absent. */
export function decodeBody(request: HttpRequest): Buffer | undefined {
  if (request.body === undefined || request.body === '') {
    return undefined;
  }
  return request.isBase64Encoded === true
    ? Buffer.from(request.body, 'base64')
    : Buffer.from(request.body, 'utf8');
}

/**
 * Extracts the token from `Authorization: Bearer <token>`. Returns an empty
 * string when the header is missing or is not a Bearer credential; the empty
 * string never matches a configured token, so `authorizeOwner` rejects it.
 */
export function bearerToken(headers: HttpRequest['headers']): string {
  const header = headers['authorization'];
  if (header === undefined) {
    return '';
  }
  const match = /^bearer (.*)$/is.exec(header);
  return match?.[1] ?? '';
}

/**
 * Static message per schema issue code. Zod's own messages can quote parts of
 * the input (for example an unrecognized key), so they are never forwarded: a
 * response carries a path and one of these fixed texts, never a received value.
 */
const MESSAGE_BY_ISSUE_CODE: Readonly<Record<string, string>> = {
  invalid_type: 'invalid type',
  invalid_format: 'invalid format',
  too_big: 'too large',
  too_small: 'too small',
  unrecognized_keys: 'unexpected field',
  custom: 'invalid value',
};
const DEFAULT_MESSAGE = 'invalid value';

/** A field error with a fixed message (see {@link MESSAGE_BY_ISSUE_CODE}). */
function field(path: string, message: string = DEFAULT_MESSAGE): ErrorField {
  return { path, message };
}

/** Fields of a schema failure; the root (no path) is reported as `body`. */
function fieldsOf(issues: readonly SchemaIssue[]): ErrorField[] {
  const seen = new Set<string>();
  const fields: ErrorField[] = [];
  for (const issue of issues) {
    const path = issue.path.length === 0 ? 'body' : issue.path.map(String).join('.');
    const message = MESSAGE_BY_ISSUE_CODE[issue.code] ?? DEFAULT_MESSAGE;
    const key = `${path}\u0000${message}`;
    if (!seen.has(key)) {
      seen.add(key);
      fields.push(field(path, message));
    }
  }
  return fields;
}

/**
 * Runs a request through the pipeline. Never rejects: every failure becomes a
 * response, and an unexpected one becomes a bare 500 `server_error` with no
 * detail.
 */
export async function executePipeline<B, P>(
  request: HttpRequest,
  definition: RouteDefinition<B, P>,
  logger: Logger,
): Promise<HttpResponse> {
  const logContext = {
    route: definition.route,
    ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
  };

  try {
    // 1. Size of the DECODED body.
    const raw = decodeBody(request);
    if (raw !== undefined && raw.byteLength > MAX_BODY_BYTES) {
      return errorResponse(ERROR_CODES.validation, { reason: ERROR_REASONS.payloadTooLarge });
    }

    // 2. Owner token (admin routes only), before looking at the body.
    if (definition.ownerToken !== undefined) {
      await authorizeOwner(definition.ownerToken, bearerToken(request.headers));
    }

    // 3. JSON, only when the route declares a body schema.
    let parsedBody: unknown;
    if (definition.bodySchema !== undefined) {
      if (raw === undefined) {
        return errorResponse(ERROR_CODES.validation, { fields: [field('body')] });
      }
      try {
        parsedBody = JSON.parse(raw.toString('utf8'));
      } catch {
        return errorResponse(ERROR_CODES.validation, { fields: [field('body')] });
      }
    }

    // 4. Schemas.
    let body = undefined as B;
    if (definition.bodySchema !== undefined) {
      const result = definition.bodySchema.safeParse(parsedBody);
      if (!result.success) {
        return errorResponse(ERROR_CODES.validation, { fields: fieldsOf(result.error.issues) });
      }
      body = result.data;
    }
    let params = undefined as P;
    if (definition.paramsSchema !== undefined) {
      const result = definition.paramsSchema.safeParse(request.pathParameters ?? {});
      if (!result.success) {
        return errorResponse(ERROR_CODES.validation, { fields: fieldsOf(result.error.issues) });
      }
      params = result.data;
    }

    // 5. Use case.
    return await definition.run({ body, params });
  } catch (error) {
    if (isDomainError(error)) {
      // Only the stable code and, for validation, the field names and the
      // reason leave here; the message is for logs and is not logged either
      // (it could be anything). Unauthorized and ServerMisconfigured never
      // carry a reason, so a wrong token cannot be told from a bad server
      // configuration (Requirement 5.5).
      if (error.code === ERROR_CODES.serverError) {
        logger.error('request_failed', { code: error.code, ...logContext });
      }
      if (error instanceof ValidationError) {
        return errorResponse(error.code, {
          fields: (error.fields ?? []).map((name) => field(name)),
          ...(error.reason !== undefined ? { reason: error.reason } : {}),
        });
      }
      return errorResponse(error.code);
    }
    logger.error('request_failed', { code: ERROR_CODES.serverError, ...logContext });
    return errorResponse(ERROR_CODES.serverError);
  }
}
