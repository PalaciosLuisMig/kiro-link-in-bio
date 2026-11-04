import { describe, expect, test } from 'vitest';

import { changesMetrics, isAdminRoute, matchRoute } from './routing.js';

// Tests of the routing of the local development server: a real method and path
// become the `routeKey` and parameters API Gateway would give the handlers.

describe('matchRoute', () => {
  test.each([
    ['GET', '/api/links', 'GET /api/links'],
    ['POST', '/api/visits', 'POST /api/visits'],
    ['POST', '/api/clicks', 'POST /api/clicks'],
    ['POST', '/api/admin/realtime-tickets', 'POST /api/admin/realtime-tickets'],
    ['GET', '/api/admin/metrics', 'GET /api/admin/metrics'],
    ['POST', '/api/admin/metrics/reset', 'POST /api/admin/metrics/reset'],
    ['GET', '/api/admin/links', 'GET /api/admin/links'],
    ['POST', '/api/admin/links', 'POST /api/admin/links'],
    ['PUT', '/api/admin/links/order', 'PUT /api/admin/links/order'],
  ])('%s %s is %s, with no path parameter', (method, path, routeKey) => {
    expect(matchRoute(method, path)).toEqual({ routeKey });
  });

  test('a single-link route keeps its template and gives the id as a parameter', () => {
    expect(matchRoute('PATCH', '/api/admin/links/abc-123')).toEqual({
      routeKey: 'PATCH /api/admin/links/{id}',
      pathParameters: { id: 'abc-123' },
    });
    expect(matchRoute('DELETE', '/api/admin/links/abc-123')).toEqual({
      routeKey: 'DELETE /api/admin/links/{id}',
      pathParameters: { id: 'abc-123' },
    });
  });

  test('the reorder path is its own route, not an id', () => {
    expect(matchRoute('PUT', '/api/admin/links/order')?.pathParameters).toBeUndefined();
  });

  test('an encoded id is decoded; a broken escape is kept as it came', () => {
    expect(matchRoute('PATCH', '/api/admin/links/a%2Fb')?.pathParameters?.id).toBe('a/b');
    expect(matchRoute('PATCH', '/api/admin/links/%E0%A4%A')?.pathParameters?.id).toBe('%E0%A4%A');
  });

  test('a wrong method matches nothing, as in API Gateway', () => {
    expect(matchRoute('DELETE', '/api/links')).toBeNull();
    expect(matchRoute('GET', '/api/clicks')).toBeNull();
    expect(matchRoute('PUT', '/api/admin/links/abc')).toBeNull();
    expect(matchRoute('get', '/api/links')).toBeNull();
  });

  test('an unknown path matches nothing', () => {
    for (const path of [
      '/',
      '/api',
      '/api/nope',
      '/api/links/',
      '/api/admin/links/',
      '/api/links/x',
    ]) {
      expect(matchRoute('GET', path)).toBeNull();
    }
  });

  test('a path parameter never swallows a slash', () => {
    expect(matchRoute('PATCH', '/api/admin/links/a/b')).toBeNull();
  });
});

describe('isAdminRoute and changesMetrics', () => {
  test('admin routes are the ones under /api/admin', () => {
    expect(isAdminRoute('GET /api/admin/metrics')).toBe(true);
    expect(isAdminRoute('PATCH /api/admin/links/{id}')).toBe(true);
    expect(isAdminRoute('GET /api/links')).toBe(false);
    expect(isAdminRoute('POST /api/clicks')).toBe(false);
  });

  test('only clicks, visits and a reset change the metrics', () => {
    expect(changesMetrics('POST /api/clicks')).toBe(true);
    expect(changesMetrics('POST /api/visits')).toBe(true);
    expect(changesMetrics('POST /api/admin/metrics/reset')).toBe(true);
    expect(changesMetrics('GET /api/admin/metrics')).toBe(false);
    expect(changesMetrics('POST /api/admin/links')).toBe(false);
    expect(changesMetrics('GET /api/links')).toBe(false);
  });
});
