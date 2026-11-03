// Composition root of the `admin-api` Lambda: wires the real adapters to the
// ports. Fails fast with a clear message when an environment variable is
// missing, at cold start (including `wsUrl`, which every ticket response needs).

import { SSMClient } from '@aws-sdk/client-ssm';

import { ENV_VARS } from '@link-in-bio/shared';

import {
  createDocumentClient,
  DynamoDbEventRepository,
  DynamoDbLinkRepository,
  DynamoDbMetricsRepository,
  DynamoDbRealtimeAccessRepository,
} from '../../lib/adapters/dynamodb-repositories.js';
import { ConsoleLogger } from '../../lib/adapters/logger.js';
import {
  NodeRandomSource,
  SystemClock,
  UuidIdGenerator,
} from '../../lib/adapters/node-services.js';
import { SsmOwnerTokenProvider } from '../../lib/adapters/ssm-owner-token-provider.js';

import type { AdminApiDeps } from './admin-api-routes.js';
import { requireEnv, type Env } from './env.js';

/** Builds the admin API dependencies from the environment. */
export function composeAdminApi(env: Env): AdminApiDeps {
  const tableName = requireEnv(env, ENV_VARS.tableName);
  const parameterName = requireEnv(env, ENV_VARS.ownerTokenParameter);
  const wsUrl = requireEnv(env, ENV_VARS.wsUrl);

  const client = createDocumentClient();
  const clock = new SystemClock();

  return {
    links: new DynamoDbLinkRepository(client, tableName),
    metrics: new DynamoDbMetricsRepository(client, tableName),
    events: new DynamoDbEventRepository(client, tableName, () => clock.now()),
    realtime: new DynamoDbRealtimeAccessRepository(client, tableName),
    ownerToken: new SsmOwnerTokenProvider(new SSMClient({}), clock, undefined, parameterName),
    clock,
    ids: new UuidIdGenerator(),
    random: new NodeRandomSource(),
    logger: new ConsoleLogger(),
    wsUrl,
  };
}
