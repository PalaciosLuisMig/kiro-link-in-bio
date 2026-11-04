// Read-only smoke test of a deployed site (or of `npm run dev`):
//
//   LOAD_TEST_API_URL=https://xxxx.cloudfront.net npm run smoke
//
// Add LOAD_TEST_TOKEN to also check that the owner token works. It only reads: it
// does not click, visit, create links or change any counter. The judging is in
// `deploy-core.ts`; this file only asks and hands over the answers.

import { API_ROUTES } from '@link-in-bio/shared';

import { evaluateSmoke, readSiteConfig, type Reply } from './deploy-core.js';
import { LoadTestConfigError, type Check } from './load-test-core.js';

const TIMEOUT_MS = 10_000;

const say = (text = ''): void => {
  process.stdout.write(`${text}\n`);
};

/** One GET. Redirects are not followed, so a 301 can be judged as it is. */
async function get(url: string, token: string | null = null, withBody = false): Promise<Reply> {
  const response = await fetch(url, {
    redirect: 'manual',
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const body = withBody ? await response.text() : (await response.arrayBuffer(), undefined);
  return body === undefined
    ? { status: response.status, headers }
    : { status: response.status, headers, body };
}

function report(checks: readonly Check[]): boolean {
  for (const item of checks) {
    say(`  ${item.ok ? 'OK    ' : 'FALLA '} [${item.requirement}] ${item.name}`);
    say(`          ${item.detail}`);
  }
  return checks.every((item) => item.ok);
}

async function main(): Promise<boolean> {
  const { siteUrl, token } = readSiteConfig(process.env);
  say(`Prueba de humo (solo lectura) contra ${siteUrl}\n`);

  const local = new URL(siteUrl).protocol === 'http:';
  const httpUrl = `${siteUrl.replace(/^https:/, 'http:')}/`;
  const [home, panel, links, adminWithoutToken, httpRedirect, adminWithToken] = await Promise.all([
    get(`${siteUrl}/`),
    get(`${siteUrl}/panel.html`),
    get(`${siteUrl}${API_ROUTES.publicLinks}`, null, true),
    get(`${siteUrl}${API_ROUTES.metrics}`),
    local ? Promise.resolve(null) : get(httpUrl),
    token === null ? Promise.resolve(null) : get(`${siteUrl}${API_ROUTES.metrics}`, token),
  ]);

  const checks = evaluateSmoke({
    home,
    panel,
    links,
    adminWithoutToken,
    httpRedirect,
    adminWithToken,
  });
  const passed = report(checks);
  if (token === null) {
    say('\n  (Sin LOAD_TEST_TOKEN no se comprueba el token del propietario.)');
  }
  return passed;
}

try {
  const passed = await main();
  say(passed ? '\nLa prueba de humo ha pasado.' : '\nLa prueba de humo ha FALLADO.');
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  if (error instanceof LoadTestConfigError) {
    process.stderr.write(
      `\n${error.message}\n\nUso:\n  LOAD_TEST_API_URL=https://xxxx.cloudfront.net npm run smoke\n\n`,
    );
  } else {
    process.stderr.write(`\nLa prueba no pudo completarse: ${(error as Error).message}\n`);
  }
  process.exitCode = 2;
}
