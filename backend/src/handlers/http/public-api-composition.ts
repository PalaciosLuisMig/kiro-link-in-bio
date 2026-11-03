// Composition root of the `public-api` Lambda: wires the real adapters to the
// ports. Fails fast with a clear message when an environment variable is
// missing, at cold start.

import { ENV_VARS } from '@link-in-bio/shared';

import { createDocumentClient } from '../../lib/adapters/dynamodb-repositories.js';
import {
  DynamoDbEventRepository,
  DynamoDbLinkRepository,
  DynamoDbMetricsRepository,
} from '../../lib/adapters/dynamodb-repositories.js';
import { ConsoleLogger } from '../../lib/adapters/logger.js';
import { SystemClock, UuidIdGenerator } from '../../lib/adapters/node-services.js';

import { requireEnv, type Env } from './env.js';
import type { PublicApiDeps } from './public-api-routes.js';

/** Builds the public API dependencies from the environment. */
export function composePublicApi(env: Env): PublicApiDeps {
  const tableName = requireEnv(env, ENV_VARS.tableName);

  const client = createDocumentClient();
  const clock = new SystemClock();

  return {
    links: new DynamoDbLinkRepository(client, tableName),
    metrics: new DynamoDbMetricsRepository(client, tableName),
    events: new DynamoDbEventRepository(client, tableName, () => clock.now()),
    clock,
    ids: new UuidIdGenerator(),
    logger: new ConsoleLogger(),
  };
}
