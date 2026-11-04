// Shared factory of the four backend Lambdas, so they all get the same runtime,
// architecture, memory, bundling and an explicit log group with retention.

import { join } from 'node:path';

import { type Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

import { DEPS_LOCK_FILE, HANDLERS_DIR } from './paths.js';

export interface BackendFunctionProps {
  /** Entry point relative to `backend/src/handlers`, e.g. `http/public-api.ts`. */
  readonly entry: string;
  /** Explicit timeout: the CDK default of 3 s is too short for some functions. */
  readonly timeout: Duration;
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * Creates a Lambda from a backend handler.
 *
 * - `nodejs24.x` on ARM64 with 512 MB (cheaper and faster per request).
 * - esbuild with minification. The AWS SDK is bundled on purpose
 *   (`externalModules: []`): the function then runs the exact SDK version in
 *   `package-lock.json`, not whichever version the managed runtime ships.
 * - An explicit `LogGroup` with 1 week retention, so logs do not live forever.
 *   The handlers log only allowed fields (code, route, request id).
 */
export function backendFunction(
  scope: Construct,
  id: string,
  props: BackendFunctionProps,
): NodejsFunction {
  const logGroup = new LogGroup(scope, `${id}Logs`, {
    retention: RetentionDays.ONE_WEEK,
    removalPolicy: RemovalPolicy.DESTROY,
  });

  return new NodejsFunction(scope, id, {
    entry: join(HANDLERS_DIR, props.entry),
    handler: 'handler',
    runtime: Runtime.NODEJS_24_X,
    architecture: Architecture.ARM_64,
    memorySize: 512,
    timeout: props.timeout,
    environment: { ...props.environment },
    logGroup,
    depsLockFilePath: DEPS_LOCK_FILE,
    bundling: { minify: true, externalModules: [] },
  });
}
