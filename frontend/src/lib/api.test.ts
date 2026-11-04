import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ApiError, getJson, postJson, REQUEST_TIMEOUT_MS, type FetchLike } from './api.js';

// Tests of the API client: the 5 s limit, the error kinds and the request shape.
//
// Validates: Requirements 1.5, 3.3.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A `fetch` that never answers and also ignores the abort signal. */
const neverAnswers: FetchLike = () => new Promise<Response>(() => {});

describe('getJson', () => {
  test('returns the parsed body of a 2xx answer', async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(json({ ok: true }));
    await expect(getJson(fetchFn, '/api/x')).resolves.toEqual({ ok: true });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/x');
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  test('a non-2xx answer is an http ApiError with its status', async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(json({}, 500));
    await expect(getJson(fetchFn, '/api/x')).rejects.toMatchObject({ kind: 'http', status: 500 });
  });

  test('a network failure is a network ApiError', async () => {
    const fetchFn = vi.fn<FetchLike>().mockRejectedValue(new TypeError('offline'));
    await expect(getJson(fetchFn, '/api/x')).rejects.toMatchObject({ kind: 'network' });
  });

  test('gives up after 5 s even when fetch ignores the abort signal', async () => {
    const result = getJson(neverAnswers, '/api/x');
    const assertion = expect(result).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    // Not yet: a rejected promise would have made `assertion` settle already.
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  test('aborts the request through its signal when the time is up', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn: FetchLike = (_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    };
    const assertion = expect(getJson(fetchFn, '/api/x')).rejects.toBeInstanceOf(ApiError);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });

  test('a body that is not JSON is a network ApiError, not a crash', async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(new Response('<html>', { status: 200 }));
    await expect(getJson(fetchFn, '/api/x')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('postJson', () => {
  test('sends a JSON body and keepalive when asked, with no timeout of its own', async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(json({}, 202));
    await postJson(fetchFn, '/api/clicks', { linkId: 'a' }, { keepalive: true });
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: 'POST',
      keepalive: true,
      body: '{"linkId":"a"}',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(init?.signal).toBeUndefined();
  });

  test('does not set keepalive unless asked', async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(json({}, 202));
    await postJson(fetchFn, '/api/visits', {});
    expect(fetchFn.mock.calls[0]?.[1]).not.toHaveProperty('keepalive');
  });

  test('with a timeout it gives up after that time', async () => {
    const assertion = expect(
      postJson(neverAnswers, '/api/visits', {}, { timeoutMs: 5000 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  test('a failure is an ApiError, whatever its cause', async () => {
    const failing = vi.fn<FetchLike>().mockRejectedValue(new TypeError('offline'));
    await expect(postJson(failing, '/api/x', {})).rejects.toMatchObject({ kind: 'network' });
    const refused = vi.fn<FetchLike>().mockResolvedValue(json({}, 404));
    await expect(postJson(refused, '/api/x', {})).rejects.toMatchObject({
      kind: 'http',
      status: 404,
    });
  });
});
