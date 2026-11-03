// Composition root of the `ws` Lambda: wires the real adapters to the ports.
// Fails fast with a clear message when an environment variable is missing, at
// cold start.

import { ENV_VARS } from '@link-in-bio/shared';

import {
  createDocumentClient,
  DynamoDbRealtimeAccessRepository,
} from '../../lib/adapters/dynamodb-repositories.js';
import { ConsoleLogger } from '../../lib/adapters/logger.js';
import { SystemClock } from '../../lib/adapters/node-services.js';
import { requireEnv, type Env } from '../http/env.js';

import type { WsDeps } from './ws-routes.js';

/** Builds the `ws` dependencies from the environment. */
export function composeWs(env: Env): WsDeps {
  const tableName = requireEnv(env, ENV_VARS.tableName);

  return {
    realtime: new DynamoDbRealtimeAccessRepository(createDocumentClient(), tableName),
    clock: new SystemClock(),
    logger: new ConsoleLogger(),
  };
}
