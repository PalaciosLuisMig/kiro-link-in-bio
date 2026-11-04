// Minimal client of the HTTP API, shared by the public page and the Panel.
//
// `fetch` is injected, so the code is tested without a network. Types and
// constants come from `shared/`; nothing here imports Zod, which must not reach
// the public bundle (Requirement 13.1).

/** The `fetch` function the client calls. */
export type FetchLike = typeof fetch;

/** Time limit of a request that must answer quickly (Requirements 1.5, 3.3). */
export const REQUEST_TIMEOUT_MS = 5000;

/**
 * Why a request failed. It carries no request content. For an `http` failure it
 * may also carry the stable `code` and `reason` of the API's error body
 * (`{ error, reason }`), so a caller can tell a full list (409 `limit_reached`)
 * from a stale one (`ids_not_permutation`) without parsing text.
 */
export class ApiError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network' | 'http',
    readonly status?: number,
    readonly code?: string,
    readonly reason?: string,
  ) {
    super(`API request failed: ${kind}${status === undefined ? '' : ` ${status}`}`);
    this.name = 'ApiError';
  }
}

/**
 * Runs `run` with an `AbortSignal` that fires after `timeoutMs`.
 *
 * It also races the call against the timer, so the limit holds even if the
 * `fetch` in use ignores the signal.
 */
async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiError('timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } catch (error) {
    throw error instanceof ApiError ? error : new ApiError('network');
  } finally {
    clearTimeout(timer);
  }
}

/** `GET` that returns the parsed JSON, or throws an {@link ApiError}. */
export async function getJson<T>(
  fetchFn: FetchLike,
  path: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<T> {
  return withTimeout(timeoutMs, async (signal) => {
    const response = await fetchFn(path, { method: 'GET', signal });
    if (!response.ok) {
      throw new ApiError('http', response.status);
    }
    return (await response.json()) as T;
  });
}

export interface PostOptions {
  /**
   * Keep the request alive if the page is unloaded. A click navigates away
   * right after sending, so its request must outlive the page.
   */
  readonly keepalive?: boolean;
  /** Abort after this many ms. Omit for no limit of our own. */
  readonly timeoutMs?: number;
}

/** `POST` with a JSON body. Resolves when the server answers 2xx. */
export async function postJson(
  fetchFn: FetchLike,
  path: string,
  body: unknown,
  options: PostOptions = {},
): Promise<void> {
  const send = async (signal?: AbortSignal): Promise<void> => {
    const response = await fetchFn(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.keepalive === true ? { keepalive: true } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!response.ok) {
      throw new ApiError('http', response.status);
    }
  };

  if (options.timeoutMs === undefined) {
    try {
      await send();
    } catch (error) {
      throw error instanceof ApiError ? error : new ApiError('network');
    }
    return;
  }
  await withTimeout(options.timeoutMs, send);
}

export interface JsonRequestOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Sent as JSON when present. */
  readonly body?: unknown;
  /** Extra headers, e.g. `Authorization`. Never put a token in the URL. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Defaults to {@link REQUEST_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** Reads `{ error, reason }` from a failed response, if it has that shape. */
async function readErrorBody(response: Response): Promise<{ code?: string; reason?: string }> {
  try {
    const body = (await response.json()) as { error?: unknown; reason?: unknown };
    return {
      ...(typeof body.error === 'string' ? { code: body.error } : {}),
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Generic JSON request with a time limit, for the admin API.
 *
 * Resolves with the parsed body, or `undefined` for a `204`. Any failure is an
 * {@link ApiError}: `timeout`, `network`, or `http` with the status and, when the
 * body has the API's error shape, its `code` and `reason`.
 */
export async function requestJson<T>(
  fetchFn: FetchLike,
  path: string,
  options: JsonRequestOptions,
): Promise<T> {
  return withTimeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS, async (signal) => {
    const response = await fetchFn(path, {
      method: options.method,
      signal,
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) {
      const { code, reason } = await readErrorBody(response);
      throw new ApiError('http', response.status, code, reason);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  });
}
