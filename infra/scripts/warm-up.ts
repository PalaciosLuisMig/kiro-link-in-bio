// Warms the Lambdas of a deployed site, a few minutes before a demo or a load test:
//
//   LOAD_TEST_API_URL=https://xxxx.cloudfront.net npm run warm-up
//
// A cold Lambda needs time to start. Many requests arriving at once while they are
// cold can pass the account limit (10 concurrent executions in a new account) and be
// rejected, as the first load test showed. This sends a few requests at once so the
// execution environments already exist. It only reads: no counter changes.
//
// `public-api` is warmed with `GET /api/links`. With LOAD_TEST_TOKEN, `admin-api` is
// warmed too, with `GET /api/admin/metrics`, after the first round and not together
// with it, so the two never add up to more than the limit. WARM_CONCURRENCY changes
// how many requests go at once (1 to 9).

import { API_ROUTES } from '@link-in-bio/shared';

import {
  ADMIN_WARM_CONCURRENCY,
  readSiteConfig,
  readWarmConcurrency,
  warmUpSummary,
} from './deploy-core.js';
import { LoadTestConfigError } from './load-test-core.js';

const TIMEOUT_MS = 10_000;

const say = (text = ''): void => {
  process.stdout.write(`${text}\n`);
};

/** Sends `count` GETs at once and returns their statuses (0 when there was no answer). */
async function burst(url: string, count: number, token: string | null): Promise<number[]> {
  return Promise.all(
    Array.from({ length: count }, async () => {
      try {
        const response = await fetch(url, {
          headers: token === null ? {} : { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        await response.arrayBuffer();
        return response.status;
      } catch {
        return 0;
      }
    }),
  );
}

async function main(): Promise<boolean> {
  const { siteUrl, token } = readSiteConfig(process.env);
  const concurrency = readWarmConcurrency(process.env);
  say(`Calentando ${siteUrl}\n`);

  const publicStatuses = await burst(`${siteUrl}${API_ROUTES.publicLinks}`, concurrency, null);
  say(warmUpSummary('public-api', publicStatuses));

  let adminStatuses: number[] = [];
  if (token === null) {
    say('admin-api: no se calienta (falta LOAD_TEST_TOKEN)');
  } else {
    adminStatuses = await burst(`${siteUrl}${API_ROUTES.metrics}`, ADMIN_WARM_CONCURRENCY, token);
    say(warmUpSummary('admin-api', adminStatuses));
  }

  return [...publicStatuses, ...adminStatuses].every((status) => status === 200);
}

try {
  const ok = await main();
  say(
    ok
      ? '\nListo. Las Lambdas se enfrían tras unos minutos sin uso: lanza la demo o la prueba de carga ya.'
      : '\nAlguna petición no dio 200. Revisa la URL y el token, y vuelve a probar.',
  );
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  if (error instanceof LoadTestConfigError) {
    process.stderr.write(
      `\n${error.message}\n\nUso:\n  LOAD_TEST_API_URL=https://xxxx.cloudfront.net npm run warm-up\n\n`,
    );
  } else {
    process.stderr.write(`\nNo se pudo calentar: ${(error as Error).message}\n`);
  }
  process.exitCode = 2;
}
