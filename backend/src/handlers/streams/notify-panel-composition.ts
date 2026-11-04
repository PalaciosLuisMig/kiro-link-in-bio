// Composition root of the `notify-panel` Lambda: wires the real adapters to the
// ports. Fails fast with a clear message when an environment variable is
// missing, at cold start.

import { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';

import { ENV_VARS } from '@link-in-bio/shared';

import { ApiGatewayRealtimeNotifier } from '../../lib/adapters/apigw-realtime-notifier.js';
import {
  createDocumentClient,
  DynamoDbEventRepository,
  DynamoDbLinkRepository,
  DynamoDbMetricsRepository,
  DynamoDbRealtimeAccessRepository,
} from '../../lib/adapters/dynamodb-repositories.js';
import { ConsoleLogger } from '../../lib/adapters/logger.js';
import { SystemClock } from '../../lib/adapters/node-services.js';
import type { NotifyPanelsDeps } from '../../lib/domain/notify-panels.js';
import { requireEnv, type Env } from '../http/env.js';

/** Builds the `notify-panel` dependencies from the environment. */
export function composeNotifyPanel(env: Env): NotifyPanelsDeps {
  const tableName = requireEnv(env, ENV_VARS.tableName);
  const endpoint = requireEnv(env, ENV_VARS.wsManagementEndpoint);

  const client = createDocumentClient();
  const clock = new SystemClock();

  return {
    realtime: new DynamoDbRealtimeAccessRepository(client, tableName),
    notifier: new ApiGatewayRealtimeNotifier(new ApiGatewayManagementApiClient({ endpoint })),
    logger: new ConsoleLogger(),
    metrics: {
      links: new DynamoDbLinkRepository(client, tableName),
      metrics: new DynamoDbMetricsRepository(client, tableName),
      events: new DynamoDbEventRepository(client, tableName, () => clock.now()),
      clock,
    },
  };
}
