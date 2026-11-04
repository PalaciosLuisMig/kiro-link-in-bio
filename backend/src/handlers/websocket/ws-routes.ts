// Routes of the `ws` Lambda: `$connect`, `$disconnect` and `$default`.
//
// One Lambda serves the three WebSocket routes and decides by `routeKey`
// (design "API WebSocket"). It works on a transport-neutral event, so it is
// testable without API Gateway; `ws.ts` maps the real event to it.
//
// Privacy: the ticket and the message body are never logged (Requirements 5.18,
// 11.2), only the allowed `code`, `route` and `requestId`.

import { MAX_KEEPALIVE_BYTES, parseKeepalive } from '@link-in-bio/shared';

import { closeConnection, openConnection } from '../../lib/domain/realtime-access.js';
import type { Clock, Logger, RealtimeAccessRepository } from '../../lib/domain/ports.js';

/** The ports the `ws` Lambda needs, injected by the composition root. */
export interface WsDeps {
  readonly realtime: RealtimeAccessRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** A WebSocket event as the routes see it. */
export interface WsEvent {
  /** `$connect`, `$disconnect` or `$default`. */
  readonly routeKey: string;
  /** API Gateway connection id: transient and not personal. */
  readonly connectionId: string;
  /** Value of the `ticket` query parameter, `$connect` only. */
  readonly ticket?: string | undefined;
  /** Message body, `$default` only. */
  readonly body?: string | undefined;
  readonly isBase64Encoded?: boolean | undefined;
  readonly requestId?: string | undefined;
}

/** What the `$connect` response means to API Gateway: 200 accepts, others reject. */
export interface WsResult {
  readonly statusCode: number;
}

/**
 * True when the message is exactly `{ "type": "keepalive" }` and no larger than
 * {@link MAX_KEEPALIVE_BYTES} bytes. The size is measured on the decoded body
 * with `Buffer.byteLength` (`shared/` cannot use Node APIs), and checked BEFORE
 * parsing so an oversized message is never parsed (Requirement 8.14).
 */
export function isKeepalive(event: Pick<WsEvent, 'body' | 'isBase64Encoded'>): boolean {
  if (event.body === undefined) {
    return false;
  }
  const bytes =
    event.isBase64Encoded === true
      ? Buffer.from(event.body, 'base64').byteLength
      : Buffer.byteLength(event.body, 'utf8');
  if (bytes > MAX_KEEPALIVE_BYTES) {
    return false;
  }
  const text =
    event.isBase64Encoded === true
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
  return parseKeepalive(text).ok;
}

/** Handles one WebSocket event. Never rejects. */
export async function handleWsEvent(deps: WsDeps, event: WsEvent): Promise<WsResult> {
  const requestId = event.requestId;
  const logContext = (code: string, route: string) => ({
    code,
    route,
    ...(requestId !== undefined ? { requestId } : {}),
  });

  switch (event.routeKey) {
    case '$connect': {
      try {
        const accepted = await openConnection(deps, event.ticket ?? '', event.connectionId);
        return { statusCode: accepted ? 200 : 401 };
      } catch {
        deps.logger.error('ws_connect_failed', logContext('ws_connect_failed', '$connect'));
        return { statusCode: 500 };
      }
    }

    case '$disconnect': {
      try {
        await closeConnection(deps.realtime, event.connectionId);
      } catch {
        // The connection is already closing. A leftover record expires with its
        // 24 h TTL, and the notifier removes it on the first 410.
        deps.logger.error(
          'ws_disconnect_failed',
          logContext('ws_disconnect_failed', '$disconnect'),
        );
      }
      return { statusCode: 200 };
    }

    case '$default': {
      // A keepalive only exists to be traffic that keeps the connection open;
      // nothing is answered or forwarded. Anything else is discarded without
      // effect and without a log entry, so a client cannot flood the logs.
      if (isKeepalive(event)) {
        deps.logger.info('ws_keepalive', logContext('ws_keepalive', '$default'));
      }
      return { statusCode: 200 };
    }

    default:
      return { statusCode: 400 };
  }
}
