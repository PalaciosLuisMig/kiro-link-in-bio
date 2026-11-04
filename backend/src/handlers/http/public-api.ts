// Lambda entry point of the public API (`GET /api/links`, `POST /api/visits`,
// `POST /api/clicks`). Composition runs once at cold start; the handler only
// adapts the event and delegates.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import { toHttpRequest, toLambdaResult } from '../../lib/http/lambda.js';

import { composePublicApi } from './public-api-composition.js';
import { handlePublicRequest } from './public-api-routes.js';

const deps = composePublicApi(process.env);

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  return toLambdaResult(await handlePublicRequest(deps, toHttpRequest(event)));
}
