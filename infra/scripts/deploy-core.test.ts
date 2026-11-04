import { describe, expect, test } from 'vitest';

import { LoadTestConfigError } from './load-test-core.js';
import {
  ACCOUNT_CONCURRENCY_LIMIT,
  DEFAULT_WARM_CONCURRENCY,
  evaluateSmoke,
  readSiteConfig,
  readWarmConcurrency,
  warmUpSummary,
  type Reply,
  type SmokeInput,
} from './deploy-core.js';

const TOKEN = 't'.repeat(40);

describe('readSiteConfig', () => {
  test('the URL is required, the token is optional and keeps only the origin of the URL', () => {
    expect(
      readSiteConfig({ LOAD_TEST_API_URL: ' https://abc.cloudfront.net/panel.html ' }),
    ).toEqual({ siteUrl: 'https://abc.cloudfront.net', token: null });
    expect(
      readSiteConfig({ LOAD_TEST_API_URL: 'https://abc.io', LOAD_TEST_TOKEN: ` ${TOKEN}\n` }),
    ).toEqual({ siteUrl: 'https://abc.io', token: TOKEN });
    expect(
      readSiteConfig({ LOAD_TEST_API_URL: 'https://abc.io', LOAD_TEST_TOKEN: '  ' }).token,
    ).toBe(null);
  });

  test('a missing URL is an error that names the variable', () => {
    expect(() => readSiteConfig({})).toThrow('LOAD_TEST_API_URL');
    expect(() => readSiteConfig({ LOAD_TEST_TOKEN: TOKEN })).toThrow(LoadTestConfigError);
  });

  test('refuses an invalid URL and http:// outside this machine, allows it on localhost', () => {
    for (const url of ['no es una url', 'http://abc.cloudfront.net', 'ftp://abc.io']) {
      expect(() => readSiteConfig({ LOAD_TEST_API_URL: url })).toThrow(LoadTestConfigError);
    }
    expect(readSiteConfig({ LOAD_TEST_API_URL: 'http://localhost:8787' }).siteUrl).toBe(
      'http://localhost:8787',
    );
  });

  test('the error never repeats the token', () => {
    let message = '';
    try {
      readSiteConfig({ LOAD_TEST_API_URL: 'http://evil.example', LOAD_TEST_TOKEN: TOKEN });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(TOKEN);
  });
});

describe('readWarmConcurrency', () => {
  test('uses a default under the account limit', () => {
    expect(readWarmConcurrency({})).toBe(DEFAULT_WARM_CONCURRENCY);
    expect(readWarmConcurrency({ WARM_CONCURRENCY: '  ' })).toBe(DEFAULT_WARM_CONCURRENCY);
    expect(DEFAULT_WARM_CONCURRENCY).toBeLessThan(ACCOUNT_CONCURRENCY_LIMIT);
  });

  test('accepts 1 up to one below the account limit', () => {
    expect(readWarmConcurrency({ WARM_CONCURRENCY: '1' })).toBe(1);
    expect(readWarmConcurrency({ WARM_CONCURRENCY: '9' })).toBe(9);
  });

  test.each(['0', '10', '11', '-1', '2.5', 'abc'])('refuses %s', (value) => {
    expect(() => readWarmConcurrency({ WARM_CONCURRENCY: value })).toThrow(LoadTestConfigError);
  });
});

const CSP_HOME =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const CSP_PANEL =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss://abc.execute-api.us-east-1.amazonaws.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const reply = (status: number, headers: Record<string, string> = {}, body?: string): Reply => ({
  status,
  headers,
  ...(body === undefined ? {} : { body }),
});

/** A deployment in which everything is right. */
function good(overrides: Partial<SmokeInput> = {}): SmokeInput {
  return {
    home: reply(200, {
      'content-type': 'text/html',
      'content-security-policy': CSP_HOME,
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    }),
    panel: reply(200, {
      'content-type': 'text/html',
      'content-security-policy': CSP_PANEL,
      'x-robots-tag': 'noindex',
    }),
    links: reply(
      200,
      { 'content-type': 'application/json', 'cache-control': 'no-store' },
      '{"links":[{"id":"a"}]}',
    ),
    adminWithoutToken: reply(401, { 'cache-control': 'no-store' }),
    httpRedirect: reply(301, { location: 'https://abc.cloudfront.net/' }),
    adminWithToken: reply(200, { 'cache-control': 'no-store' }),
    ...overrides,
  };
}

const withoutHeader = (
  headers: Readonly<Record<string, string>>,
  name: string,
): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name));

const failed = (input: SmokeInput): string[] =>
  evaluateSmoke(input)
    .filter((item) => !item.ok)
    .map((item) => item.name);

describe('evaluateSmoke', () => {
  test('a right deployment passes every check, and covers requirement 17', () => {
    const checks = evaluateSmoke(good());
    expect(checks.every((item) => item.ok)).toBe(true);
    const covered = new Set(checks.map((item) => item.requirement));
    for (const requirement of ['17.1', '17.2', '17.3', '17.4']) {
      expect(covered).toContain(requirement);
    }
  });

  test('the redirect and the token checks are left out when they do not apply', () => {
    const names = evaluateSmoke(good({ httpRedirect: null, adminWithToken: null })).map(
      (item) => item.name,
    );
    expect(names).toHaveLength(8);
    expect(names.join('|')).not.toContain('http://');
    expect(names.join('|')).not.toContain('token del propietario es válido');
  });

  test('a page that does not answer 200 with HTML fails', () => {
    expect(failed(good({ home: reply(403) }))).toContain('La página pública responde');
    expect(failed(good({ panel: reply(200, { 'content-type': 'application/json' }) }))).toContain(
      'El Panel responde',
    );
  });

  test('a weak CSP fails: unsafe-inline, a missing frame-ancestors or no header at all', () => {
    const weak = (csp: string) =>
      good({
        home: {
          ...good().home,
          headers: { ...good().home.headers, 'content-security-policy': csp },
        },
      });
    expect(
      failed(weak(CSP_HOME.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"))),
    ).toHaveLength(1);
    expect(
      failed(weak(CSP_HOME.replace("frame-ancestors 'none'", 'frame-ancestors *'))),
    ).toHaveLength(1);
    expect(failed(weak(''))).toHaveLength(1);
  });

  test('the Panel CSP must allow a wss:// connection, and only wss://', () => {
    const withConnect = (connect: string) =>
      good({
        panel: {
          ...good().panel,
          headers: {
            ...good().panel.headers,
            'content-security-policy': CSP_PANEL.replace(
              "connect-src 'self' wss://abc.execute-api.us-east-1.amazonaws.com",
              connect,
            ),
          },
        },
      });
    expect(failed(withConnect("connect-src 'self'"))).toHaveLength(1);
    expect(failed(withConnect("connect-src 'self' ws://abc.io"))).toHaveLength(1);
    expect(failed(withConnect("connect-src 'self' wss://abc.io"))).toHaveLength(0);
  });

  test.each([['strict-transport-security'], ['x-content-type-options'], ['referrer-policy']])(
    'a home page without %s fails',
    (name) => {
      const rest = withoutHeader(good().home.headers, name);
      expect(failed(good({ home: { ...good().home, headers: rest } }))).toEqual([
        'HSTS, nosniff y Referrer-Policy en la página pública',
      ]);
    },
  );

  test('a Panel without noindex fails', () => {
    const rest = withoutHeader(good().panel.headers, 'x-robots-tag');
    expect(failed(good({ panel: { ...good().panel, headers: rest } }))).toEqual([
      'El Panel pide no ser indexado',
    ]);
  });

  test('/api/links must be 200, a list and no-store', () => {
    const json = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    expect(failed(good({ links: reply(200, json, '{"links":[]}') }))).toEqual([]);
    expect(failed(good({ links: reply(500, json, '{"links":[]}') }))).toHaveLength(1);
    expect(failed(good({ links: reply(200, json, '{"error":"x"}') }))).toHaveLength(1);
    expect(failed(good({ links: reply(200, json, 'no es json') }))).toHaveLength(1);
    expect(failed(good({ links: reply(200, {}, '{"links":[]}') }))).toHaveLength(1);
  });

  test('the admin API must refuse a missing token with 401 and no-store', () => {
    expect(
      failed(good({ adminWithoutToken: reply(200, { 'cache-control': 'no-store' }) })),
    ).toHaveLength(1);
    expect(failed(good({ adminWithoutToken: reply(401) }))).toHaveLength(1);
  });

  test('http:// must redirect to https://, not to another http:// or answer 200', () => {
    expect(failed(good({ httpRedirect: reply(200) }))).toHaveLength(1);
    expect(failed(good({ httpRedirect: reply(301, { location: 'http://abc.io/' }) }))).toHaveLength(
      1,
    );
    expect(failed(good({ httpRedirect: reply(301) }))).toHaveLength(1);
    expect(failed(good({ httpRedirect: reply(308, { location: 'https://abc.io/' }) }))).toEqual([]);
  });

  test('a wrong token fails the token check', () => {
    expect(failed(good({ adminWithToken: reply(401, { 'cache-control': 'no-store' }) }))).toEqual([
      'El token del propietario es válido en la API de gestión',
    ]);
  });
});

describe('warmUpSummary', () => {
  test('says how many requests got each status', () => {
    expect(warmUpSummary('public-api', [200, 200, 503])).toBe(
      'public-api: 3 peticiones (200 x2, 503 x1)',
    );
  });
});
