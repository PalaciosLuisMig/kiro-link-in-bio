// Lambda entry point of the admin API (tickets, metrics, reset and link
// management). Composition runs once at cold start; the handler only adapts the
// event and delegates.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import { toHttpRequest, toLambdaResult } from '../../lib/http/lambda.js';

import { composeAdminApi } from './admin-api-composition.js';
import { handleAdminRequest } from './admin-api-routes.js';

const deps = composeAdminApi(process.env);

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  return toLambdaResult(await handleAdminRequest(deps, toHttpRequest(event)));
}
