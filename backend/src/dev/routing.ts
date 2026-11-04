// Routing of the LOCAL development server (not deployed).
//
// API Gateway turns a request into a `routeKey` (`POST /api/clicks`) and path
// parameters before the Lambda runs. The handlers expect exactly that, so the local
// server has to do the same from a real method and path.

import { API_ROUTES } from '@link-in-bio/shared';

export interface RouteMatch {
  /** `METHOD template`, e.g. `PATCH /api/admin/links/{id}`. */
  readonly routeKey: string;
  readonly pathParameters?: { readonly id: string };
}

interface Route {
  readonly method: string;
  readonly template: string;
  readonly pattern: RegExp;
}

function route(method: string, template: string): Route {
  const escaped = template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace('{id}', '([^/]+)');
  return { method, template, pattern: new RegExp(`^${escaped}$`) };
}

/** Every route of the API, the same as the HTTP API of the CDK stack. */
const ROUTES: readonly Route[] = [
  route('GET', API_ROUTES.publicLinks),
  route('POST', API_ROUTES.visits),
  route('POST', API_ROUTES.clicks),
  route('POST', API_ROUTES.realtimeTickets),
  route('GET', API_ROUTES.metrics),
  route('POST', API_ROUTES.metricsReset),
  route('GET', API_ROUTES.adminLinks),
  route('POST', API_ROUTES.adminLinks),
  route('PUT', API_ROUTES.adminLinksOrder),
  route('PATCH', API_ROUTES.adminLink),
  route('DELETE', API_ROUTES.adminLink),
];

/** Decodes a path parameter; a malformed escape is kept as it came (the handler rejects it). */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Finds the route of a request, or `null` when none matches (API Gateway answers
 * 404 for those). The method is compared exactly, as API Gateway does.
 */
export function matchRoute(method: string, pathname: string): RouteMatch | null {
  for (const candidate of ROUTES) {
    if (candidate.method !== method) {
      continue;
    }
    const match = candidate.pattern.exec(pathname);
    if (match === null) {
      continue;
    }
    const routeKey = `${candidate.method} ${candidate.template}`;
    const id = match[1];
    return id === undefined ? { routeKey } : { routeKey, pathParameters: { id: decode(id) } };
  }
  return null;
}

/** True for the routes that need the owner token. */
export function isAdminRoute(routeKey: string): boolean {
  return routeKey.includes('/api/admin/');
}

/** The routes whose success changes the metrics, so the Panels must be notified. */
export function changesMetrics(routeKey: string): boolean {
  return (
    routeKey === `POST ${API_ROUTES.clicks}` ||
    routeKey === `POST ${API_ROUTES.visits}` ||
    routeKey === `POST ${API_ROUTES.metricsReset}`
  );
}
