// Lambda entry point of the WebSocket API (`$connect`, `$disconnect`,
// `$default`). Composition runs once at cold start; the handler only adapts the
// event and delegates. `$connect` answers 200 to accept and 401 to reject.

import type {
  APIGatewayProxyStructuredResultV2,
  APIGatewayProxyWebsocketEventV2,
} from 'aws-lambda';

import { WS_TICKET_PARAM } from '@link-in-bio/shared';

import { composeWs } from './ws-composition.js';
import { handleWsEvent } from './ws-routes.js';

const deps = composeWs(process.env);

export async function handler(
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { statusCode } = await handleWsEvent(deps, {
    routeKey: event.requestContext.routeKey,
    connectionId: event.requestContext.connectionId,
    ticket: event.queryStringParameters?.[WS_TICKET_PARAM],
    body: event.body,
    isBase64Encoded: event.isBase64Encoded,
    requestId: event.requestContext.requestId,
  });
  return { statusCode };
}
