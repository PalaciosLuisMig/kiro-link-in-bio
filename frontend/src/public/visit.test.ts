import { describe, expect, test, vi } from 'vitest';

import { API_ROUTES } from '@link-in-bio/shared';

import type { FetchLike } from '../lib/api.js';

import { createVisitReporter } from './visit.js';

// Tests of the visit reporter, apart from the page: the guard that keeps it to
// one visit per page load cannot be reached through the page (a retry only
// happens after a failure, when no visit was sent), so it is tested directly.
//
// Validates: Requirements 3.1, 3.3.

describe('createVisitReporter', () => {
  test('sends one visit however many times `report` is called', () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(new Response('{}', { status: 202 }));
    const reporter = createVisitReporter({ fetch: fetchFn, channel: 'qr' });

    reporter.report();
    reporter.report();
    reporter.report();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(API_ROUTES.visits);
    expect(fetchFn.mock.calls[0]?.[1]?.body).toBe('{"channel":"qr"}');
  });

  test('does not send again after a failed visit (no retry)', async () => {
    const fetchFn = vi.fn<FetchLike>().mockRejectedValue(new TypeError('offline'));
    const reporter = createVisitReporter({ fetch: fetchFn, channel: undefined });

    reporter.report();
    await Promise.resolve();
    reporter.report();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[1]?.body).toBe('{}');
  });

  test('survives a fetch that throws synchronously', () => {
    const fetchFn: FetchLike = () => {
      throw new TypeError('invalid');
    };
    const reporter = createVisitReporter({ fetch: fetchFn, channel: 'qr' });
    expect(() => reporter.report()).not.toThrow();
  });

  test('each page load has its own reporter', () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(new Response('{}', { status: 202 }));
    createVisitReporter({ fetch: fetchFn, channel: 'a' }).report();
    createVisitReporter({ fetch: fetchFn, channel: 'b' }).report();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
