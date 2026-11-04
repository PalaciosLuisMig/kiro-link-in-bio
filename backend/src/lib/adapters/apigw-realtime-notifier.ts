// API Gateway Management API adapter for the RealtimeNotifier port.
//
// This module is in the ADAPTERS layer, so it may depend on the AWS SDK
// (`structure.md`). It implements `RealtimeNotifier.send()` by pushing a
// serialized snapshot to one WebSocket connection with `PostToConnection`.
//
// The 410 translation (design 12.7): when the connection has closed, API Gateway
// answers HTTP 410 and the SDK throws a `GoneException`. This adapter turns that
// single signal into `'gone'` so `notifyPanels` can delete the stale connection
// and carry on; a successful post returns `'sent'`; ANY other error rejects, so
// `notifyPanels` logs it and continues with the remaining connections (12.6).
//
// The management client is INJECTED (constructor param), not created here: the
// composition root (task 11.x) builds it with the stage's management endpoint,
// and the unit tests drive the adapter with a fake — no AWS needed.

import type { PostToConnectionCommandOutput } from '@aws-sdk/client-apigatewaymanagementapi';
import { PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import type { MetricsSnapshot } from '@link-in-bio/shared';
import { serialize, snapshotMessage } from '@link-in-bio/shared';

import type { RealtimeNotifier, SendResult } from '../domain/ports.js';

/** HTTP status API Gateway returns for a closed connection. */
const GONE_STATUS = 410;

/** `name` of the SDK exception thrown for a closed connection. */
const GONE_EXCEPTION = 'GoneException';

/**
 * The subset of the API Gateway Management client this adapter uses: a single
 * `send` of a `PostToConnectionCommand`. Narrowing it keeps the adapter
 * decoupled from the full client surface and makes a fake trivial in tests.
 */
export interface PostToConnectionSend {
  send(command: PostToConnectionCommand): Promise<PostToConnectionCommandOutput>;
}

/**
 * True when `error` means the target connection is gone (HTTP 410): either a
 * `GoneException` by name, or any error whose `$metadata.httpStatusCode` is 410.
 * Both signals are accepted so a minified/re-shaped error still maps correctly.
 */
function isGone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  if (name === GONE_EXCEPTION) {
    return true;
  }
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return status === GONE_STATUS;
}

/**
 * {@link RealtimeNotifier} backed by the API Gateway Management API.
 *
 * `send` serializes the snapshot into a `snapshot` message (via `shared`),
 * posts it to the connection, and returns `'sent'` on success or `'gone'` when
 * the connection has closed (410). Any other failure is rethrown unchanged.
 */
export class ApiGatewayRealtimeNotifier implements RealtimeNotifier {
  constructor(private readonly client: PostToConnectionSend) {}

  async send(connectionId: string, payload: MetricsSnapshot): Promise<SendResult> {
    try {
      await this.client.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: serialize(snapshotMessage(payload)),
        }),
      );
      return 'sent';
    } catch (error) {
      if (isGone(error)) {
        return 'gone';
      }
      throw error;
    }
  }
}
