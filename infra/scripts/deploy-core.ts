// Pure pieces of the post-deploy scripts (`smoke.ts` and `warm-up.ts`): reading their
// settings and judging what the deployed site answered. No network and no `process`,
// so all of it is tested in `deploy-core.test.ts`.

import {
  LoadTestConfigError,
  describeStatuses,
  parseSiteUrl,
  type Check,
} from './load-test-core.js';

/** Most concurrent Lambda executions a new AWS account allows. The warm-up stays under it. */
export const ACCOUNT_CONCURRENCY_LIMIT = 10;
/** Requests the warm-up sends at once to `public-api`. Under the limit, to leave room. */
export const DEFAULT_WARM_CONCURRENCY = 8;
/** Requests the warm-up sends to `admin-api` when a token is given. */
export const ADMIN_WARM_CONCURRENCY = 3;

export interface SiteConfig {
  /** Base URL of the deployed app, without a trailing slash. */
  readonly siteUrl: string;
  /** Owner token, only to check the admin API. Never printed. */
  readonly token: string | null;
}

/**
 * Reads `LOAD_TEST_API_URL` (required) and `LOAD_TEST_TOKEN` (optional): the same
 * variables as the load test, so one setup serves all three scripts.
 */
export function readSiteConfig(env: Readonly<Record<string, string | undefined>>): SiteConfig {
  const rawUrl = env.LOAD_TEST_API_URL?.trim() ?? '';
  if (rawUrl === '') {
    throw new LoadTestConfigError(
      'Falta LOAD_TEST_API_URL (la URL de la app, por ejemplo https://xxxx.cloudfront.net).',
    );
  }
  const token = env.LOAD_TEST_TOKEN?.trim() ?? '';
  return { siteUrl: parseSiteUrl(rawUrl), token: token === '' ? null : token };
}

/**
 * How many requests the warm-up sends at once. `WARM_CONCURRENCY` can change it, but
 * never to the account limit or above: those requests would be throttled, which is
 * what the warm-up is meant to avoid.
 */
export function readWarmConcurrency(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.WARM_CONCURRENCY?.trim();
  if (raw === undefined || raw === '') {
    return DEFAULT_WARM_CONCURRENCY;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value >= ACCOUNT_CONCURRENCY_LIMIT) {
    throw new LoadTestConfigError(
      `WARM_CONCURRENCY debe ser un entero entre 1 y ${ACCOUNT_CONCURRENCY_LIMIT - 1}.`,
    );
  }
  return value;
}

/** What one request answered. Header names are lowercase. */
export interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Only read for `/api/links`. */
  readonly body?: string;
}

export interface SmokeInput {
  readonly home: Reply;
  readonly panel: Reply;
  readonly links: Reply;
  readonly adminWithoutToken: Reply;
  /** The same home URL over `http://`, not followed. `null` for a local server. */
  readonly httpRedirect: Reply | null;
  /** `GET /api/admin/metrics` with the token. `null` when no token was given. */
  readonly adminWithToken: Reply | null;
}

const check = (name: string, requirement: string, ok: boolean, detail: string): Check => ({
  name,
  requirement,
  ok,
  detail,
});

const header = (reply: Reply, name: string): string => reply.headers[name] ?? '';
const isHtml = (reply: Reply): boolean => header(reply, 'content-type').includes('text/html');
const noStore = (reply: Reply): boolean => header(reply, 'cache-control').includes('no-store');

/** Directive of a Content-Security-Policy, or `''` when it is missing. */
function directive(policy: string, name: string): string {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return found ?? '';
}

/** Number of links in the body of `GET /api/links`, or `null` if it is not that shape. */
function countLinks(body: string | undefined): number | null {
  try {
    const parsed: unknown = JSON.parse(body ?? '');
    const links = (parsed as { links?: unknown } | null)?.links;
    return Array.isArray(links) ? links.length : null;
  } catch {
    return null;
  }
}

/**
 * Judges the read-only checks after a deploy: the pages are there, the security
 * headers of requirement 17 are on, the API answers and refuses a missing token.
 */
export function evaluateSmoke(input: SmokeInput): Check[] {
  const { home, panel, links, adminWithoutToken, httpRedirect, adminWithToken } = input;
  const homeCsp = header(home, 'content-security-policy');
  const panelCsp = header(panel, 'content-security-policy');
  const linkCount = countLinks(links.body);

  const checks: Check[] = [
    check(
      'La página pública responde',
      '–',
      home.status === 200 && isHtml(home),
      `estado ${home.status}, ${header(home, 'content-type') || 'sin tipo'}`,
    ),
    check(
      'El Panel responde',
      '–',
      panel.status === 200 && isHtml(panel),
      `estado ${panel.status}, ${header(panel, 'content-type') || 'sin tipo'}`,
    ),
    check(
      'CSP de la página pública: solo scripts propios y sin marcos de otros sitios',
      '17.2',
      directive(homeCsp, 'script-src') === "script-src 'self'" &&
        directive(homeCsp, 'frame-ancestors') === "frame-ancestors 'none'" &&
        !homeCsp.includes('unsafe-'),
      homeCsp === '' ? 'falta la cabecera' : homeCsp,
    ),
    check(
      'CSP del Panel: conexiones solo al propio dominio y al WebSocket (wss://)',
      '17.2',
      /connect-src 'self' wss:\/\/\S+/.test(directive(panelCsp, 'connect-src')) &&
        !panelCsp.includes('unsafe-'),
      directive(panelCsp, 'connect-src') || 'falta connect-src',
    ),
    check(
      'HSTS, nosniff y Referrer-Policy en la página pública',
      '17.2',
      /max-age=\d+/.test(header(home, 'strict-transport-security')) &&
        header(home, 'x-content-type-options') === 'nosniff' &&
        header(home, 'referrer-policy') !== '',
      `HSTS: ${header(home, 'strict-transport-security') || 'falta'}; nosniff: ${header(home, 'x-content-type-options') || 'falta'}; referrer: ${header(home, 'referrer-policy') || 'falta'}`,
    ),
    check(
      'El Panel pide no ser indexado',
      '17.4',
      header(panel, 'x-robots-tag').includes('noindex'),
      `X-Robots-Tag: ${header(panel, 'x-robots-tag') || 'falta'}`,
    ),
    check(
      'GET /api/links responde con la lista de enlaces',
      '17.3',
      links.status === 200 && linkCount !== null && noStore(links),
      linkCount === null
        ? `estado ${links.status}, el cuerpo no es { links: [...] }`
        : `estado ${links.status}, ${linkCount} enlaces, cache-control: ${header(links, 'cache-control') || 'falta'}`,
    ),
    check(
      'La API de gestión rechaza una petición sin token',
      '17.3',
      adminWithoutToken.status === 401 && noStore(adminWithoutToken),
      `estado ${adminWithoutToken.status}, cache-control: ${header(adminWithoutToken, 'cache-control') || 'falta'}`,
    ),
  ];

  if (httpRedirect !== null) {
    const location = header(httpRedirect, 'location');
    checks.push(
      check(
        'http:// redirige a https://',
        '17.1',
        [301, 302, 307, 308].includes(httpRedirect.status) && location.startsWith('https://'),
        `estado ${httpRedirect.status}, destino ${location || 'ninguno'}`,
      ),
    );
  }
  if (adminWithToken !== null) {
    checks.push(
      check(
        'El token del propietario es válido en la API de gestión',
        '5',
        adminWithToken.status === 200 && noStore(adminWithToken),
        `estado ${adminWithToken.status}`,
      ),
    );
  }
  return checks;
}

/** Summary line of a warm-up round: how many requests got each status. */
export function warmUpSummary(label: string, statuses: readonly number[]): string {
  return `${label}: ${statuses.length} peticiones (${describeStatuses(statuses)})`;
}
