// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { API_ROUTES } from '@link-in-bio/shared';

import { ApiError, type FetchLike } from '../lib/api.js';

import { createAdminApi, UnauthorizedError } from './api.js';
import {
  cleanToken,
  createSession,
  readTokenInput,
  resumeSession,
  signIn,
  TOKEN_STORAGE_KEY,
  type TokenStorage,
} from './auth.js';

// Tests of the Panel session and of the sign-in (tasks 15.6 and 15.7), with a fake
// `fetch` and a fake `sessionStorage`: trimming, an empty value that sends no
// request, a 401 that forgets the token, a network error shown differently, the
// token never in a URL, and a token `fetch` cannot send read as "Token no válido".
//
// Validates: Requirements 5.1, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13.

class FakeStorage implements TokenStorage {
  readonly values = new Map<string, string>();
  getItem = (key: string): string | null => this.values.get(key) ?? null;
  setItem = (key: string, value: string): void => void this.values.set(key, value);
  removeItem = (key: string): void => void this.values.delete(key);
}

const TOKEN = 'a'.repeat(40);

describe('cleanToken and readTokenInput', () => {
  test('trim spaces and line breaks at both ends, and only there (5.1)', () => {
    expect(cleanToken('  abc  ')).toBe('abc');
    expect(cleanToken('\n\tabc\r\n')).toBe('abc');
    expect(cleanToken('a b')).toBe('a b');
  });

  test('an empty or all-whitespace value is refused (5.12)', () => {
    for (const raw of ['', '   ', '\n', ' \t \r\n ']) {
      expect(readTokenInput(raw)).toEqual({ ok: false });
    }
    expect(readTokenInput('  abc ')).toEqual({ ok: true, token: 'abc' });
  });
});

describe('createSession', () => {
  test('keeps the token in memory and in sessionStorage (5.10)', () => {
    const storage = new FakeStorage();
    const session = createSession(storage);
    expect(session.token()).toBeNull();

    session.save(TOKEN);
    expect(session.token()).toBe(TOKEN);
    expect(storage.values.get(TOKEN_STORAGE_KEY)).toBe(TOKEN);
  });

  test('a reloaded tab keeps the session: a new session reads what was saved (5.10)', () => {
    const storage = new FakeStorage();
    createSession(storage).save(TOKEN);
    expect(createSession(storage).token()).toBe(TOKEN);
  });

  test('clear forgets it from memory and from storage (5.8, 5.11)', () => {
    const storage = new FakeStorage();
    const session = createSession(storage);
    session.save(TOKEN);
    session.clear();
    expect(session.token()).toBeNull();
    expect(storage.values.size).toBe(0);
    expect(createSession(storage).token()).toBeNull();
  });

  test('works in memory when sessionStorage is missing or throws', () => {
    const throwing: TokenStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    for (const storage of [null, throwing]) {
      const session = createSession(storage);
      expect(session.token()).toBeNull();
      session.save(TOKEN);
      expect(session.token()).toBe(TOKEN);
      session.clear();
      expect(session.token()).toBeNull();
    }
  });

  test('never writes a cookie or local storage (5.10)', () => {
    window.localStorage.clear();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const session = createSession(null);
    session.save(TOKEN);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    setItem.mockRestore();
  });
});

describe('signIn and resumeSession', () => {
  let storage: FakeStorage;
  let calls: number;

  const deps = (validate: () => Promise<unknown>) => ({
    session: createSession(storage),
    validate: async () => {
      calls += 1;
      return validate();
    },
  });

  beforeEach(() => {
    storage = new FakeStorage();
    calls = 0;
  });

  test('an empty value sends no request and saves nothing (5.12)', async () => {
    const d = deps(async () => undefined);
    for (const raw of ['', '   ', '\n']) {
      expect(await signIn(d, raw)).toBe('empty');
    }
    expect(calls).toBe(0);
    expect(storage.values.size).toBe(0);
  });

  test('saves the cleaned token and checks it (5.1)', async () => {
    const d = deps(async () => undefined);
    expect(await signIn(d, `  ${TOKEN}\n`)).toBe('ok');
    expect(calls).toBe(1);
    expect(d.session.token()).toBe(TOKEN);
  });

  test('a 401 forgets the token and reports "unauthorized" (5.8)', async () => {
    const d = deps(async () => {
      throw new UnauthorizedError();
    });
    expect(await signIn(d, TOKEN)).toBe('unauthorized');
    expect(d.session.token()).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  test('a network error or timeout is "unreachable", different from a wrong token (5.13)', async () => {
    for (const error of [
      new ApiError('network'),
      new ApiError('timeout'),
      new ApiError('http', 500),
    ]) {
      const d = deps(async () => {
        throw error;
      });
      expect(await signIn(d, TOKEN)).toBe('unreachable');
    }
  });

  test('a reloaded tab with a saved token checks it again; with none it does nothing', async () => {
    expect(await resumeSession(deps(async () => undefined))).toBe('none');
    expect(calls).toBe(0);

    createSession(storage).save(TOKEN);
    expect(await resumeSession(deps(async () => undefined))).toBe('ok');
    expect(calls).toBe(1);
  });

  test('a saved token the API refuses on reload is forgotten', async () => {
    createSession(storage).save(TOKEN);
    const d = deps(async () => {
      throw new UnauthorizedError();
    });
    expect(await resumeSession(d)).toBe('unauthorized');
    expect(storage.values.size).toBe(0);
  });
});

describe('admin API client', () => {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status });

  function client(fetchFn: FetchLike, token: string | null = TOKEN) {
    return createAdminApi({ fetch: fetchFn, getToken: () => token });
  }

  test('sends the token only in the Authorization header, never in the URL or body (5.1, 5.9)', async () => {
    const fetchFn = vi.fn<FetchLike>().mockImplementation(async () => json({ links: [] }));
    await client(fetchFn).listLinks();
    await client(fetchFn).createLink({ title: 'Mi web', url: 'https://ejemplo.com' });

    for (const [url, init] of fetchFn.mock.calls) {
      expect(String(url)).not.toContain(TOKEN);
      expect(String(init?.body ?? '')).not.toContain(TOKEN);
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    }
    expect(fetchFn.mock.calls[0]?.[0]).toBe(API_ROUTES.adminLinks);
  });

  test('a 401 is an UnauthorizedError', async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(json({ error: 'unauthorized' }, 401));
    await expect(client(fetchFn).listLinks()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test('other failures stay ApiError, with the code and reason of the body', async () => {
    const full = vi.fn<FetchLike>().mockResolvedValue(json({ error: 'limit_reached' }, 409));
    await expect(
      client(full).createLink({ title: 'x', url: 'https://a.com' }),
    ).rejects.toMatchObject({ kind: 'http', status: 409, code: 'limit_reached' });

    const stale = vi
      .fn<FetchLike>()
      .mockResolvedValue(json({ error: 'validation', reason: 'ids_not_permutation' }, 400));
    await expect(client(stale).reorderLinks(['a'])).rejects.toMatchObject({
      status: 400,
      reason: 'ids_not_permutation',
    });

    const down = vi.fn<FetchLike>().mockRejectedValue(new TypeError('offline'));
    await expect(client(down).listLinks()).rejects.toMatchObject({ kind: 'network' });
  });

  test('no token: it says unauthorized without sending a request', async () => {
    const fetchFn = vi.fn<FetchLike>();
    await expect(client(fetchFn, null).listLinks()).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(client(fetchFn, '').listLinks()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('a token with characters fetch cannot send is read as "Token no válido"', async () => {
    // `fetch` throws a TypeError when it builds a header with a non-Latin-1 value.
    const fetchFn = vi.fn<FetchLike>().mockImplementation(() => {
      throw new TypeError('invalid header value');
    });
    for (const token of ['contraseña-€', 'token-日本語', 'emoji-🔑']) {
      await expect(client(fetchFn, token).listLinks()).rejects.toBeInstanceOf(UnauthorizedError);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('link ids are URL-encoded in the path', async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 204 }));
    await client(fetchFn).deleteLink('a/b?c');
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/admin/links/a%2Fb%3Fc');
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  test('uses the right method and body for each operation', async () => {
    const fetchFn = vi
      .fn<FetchLike>()
      .mockImplementation(async () =>
        json({ links: [], epoch: 5, id: 'x', ticket: 't', expiresAt: 1, wsUrl: 'wss://x' }),
      );
    const api = client(fetchFn);
    await api.updateLink('abc', { active: false });
    await api.reorderLinks(['b', 'a']);
    await api.resetMetrics();
    await api.issueTicket();

    const seen = fetchFn.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`);
    expect(seen).toEqual([
      'PATCH /api/admin/links/abc',
      'PUT /api/admin/links/order',
      'POST /api/admin/metrics/reset',
      'POST /api/admin/realtime-tickets',
    ]);
    expect(fetchFn.mock.calls[0]?.[1]?.body).toBe('{"active":false}');
    expect(fetchFn.mock.calls[1]?.[1]?.body).toBe('{"ids":["b","a"]}');
  });

  test('metrics that are not a snapshot are a failed load, never partial values', async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(json({ totals: { clicks: 'many' } }));
    await expect(client(fetchFn).getMetrics()).rejects.toMatchObject({ kind: 'network' });
  });
});
