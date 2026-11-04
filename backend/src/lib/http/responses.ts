// Response builders. Every response carries `Cache-Control: no-store` and none
// carries CORS headers: the API is same-origin only (Requirements 14.5, 17.3).

import {
  ERROR_CODES,
  type ErrorBody,
  type ErrorCode,
  type ErrorField,
  type ErrorReason,
} from '@link-in-bio/shared';

import type { HttpResponse } from './types.js';

const BASE_HEADERS = { 'Cache-Control': 'no-store' } as const;

/** A JSON response with the given status. */
export function jsonResponse(statusCode: number, body: unknown): HttpResponse {
  return {
    statusCode,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** A response with no body (202 `{}` is a JSON response; 204 is this one). */
export function emptyResponse(statusCode: number): HttpResponse {
  return { statusCode, headers: { ...BASE_HEADERS } };
}

/** HTTP status for each error code (design "Error Handling"). */
const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  [ERROR_CODES.validation]: 400,
  [ERROR_CODES.unauthorized]: 401,
  [ERROR_CODES.notFound]: 404,
  [ERROR_CODES.limitReached]: 409,
  [ERROR_CODES.serverError]: 500,
};

/** Optional parts of an error body. */
export interface ErrorDetails {
  readonly fields?: readonly ErrorField[];
  readonly reason?: ErrorReason;
}

/**
 * An error response `{ error, fields?, reason? }`. `fields` carries only paths
 * and static messages, never values; no trace, body, header or token can be
 * passed in.
 */
export function errorResponse(code: ErrorCode, details: ErrorDetails = {}): HttpResponse {
  const body: ErrorBody = {
    error: code,
    ...(details.fields !== undefined && details.fields.length > 0
      ? { fields: [...details.fields] }
      : {}),
    ...(details.reason !== undefined ? { reason: details.reason } : {}),
  };
  return jsonResponse(STATUS_BY_CODE[code], body);
}
