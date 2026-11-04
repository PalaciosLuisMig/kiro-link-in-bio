// Adapter between API Gateway HTTP API (payload v2) events and the pipeline's
// transport-neutral request/response. The only file that knows the event shape.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import type { HttpRequest, HttpResponse } from './types.js';

/** Maps a Lambda event to an {@link HttpRequest}, keeping only what the pipeline reads. */
export function toHttpRequest(event: APIGatewayProxyEventV2): HttpRequest {
  return {
    routeKey: event.routeKey,
    headers: event.headers ?? {},
    body: event.body,
    isBase64Encoded: event.isBase64Encoded,
    pathParameters: event.pathParameters,
    requestId: event.requestContext?.requestId,
  };
}

/** Maps an {@link HttpResponse} to the structured Lambda result. */
export function toLambdaResult(response: HttpResponse): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: response.statusCode,
    headers: { ...response.headers },
    ...(response.body !== undefined ? { body: response.body } : {}),
  };
}
