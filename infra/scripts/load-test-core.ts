// Pure pieces of the load test (task 16): percentiles, latency pairing, counter
// increments and the checks that decide pass or fail. No network, no clock and no
// `process`, so all of it is tested in `load-test-core.test.ts`. The runner
// (`load-test.ts`) only does the I/O and hands the numbers to these functions.

import type { MetricsSnapshot } from '@link-in-bio/shared';

/** Clicks (and, in the second phase, visits) sent in each phase (12.1, 12.5). */
export const REQUESTS = 500;
/** The requests are spread evenly over this time, in milliseconds (12.1). */
export const SPREAD_MS = 10_000;
/** Wait after the last confirmation before reading the metrics (8.8 asks for 4 s; 12.1 for 1 s). */
export const SETTLE_MS = 4_000;
/** p95 of the response time of the public API, in milliseconds (12.4). */
export const MAX_HTTP_P95_MS = 1_000;
/** p95 of the time from a 202 to the real-time message, in milliseconds (8.1, 8.2). */
export const MAX_WS_P95_MS = 3_000;

export interface LoadTestConfig {
  /** Base URL of the deployed app, without a trailing slash. */
  readonly apiUrl: string;
  /** Owner token. Never printed. */
  readonly token: string;
}

/** The URL or the token is missing or wrong. The message says how to fix it. */
export class LoadTestConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadTestConfigError';
  }
}

/**
 * Reads `LOAD_TEST_API_URL` and `LOAD_TEST_TOKEN`. The URL must be `https://`, so
 * the token never travels in clear text, except for a server on this same machine
 * (`http://localhost`, `127.0.0.1` or `[::1]`), which allows trying the script
 * against `npm run dev`.
 */
export function readLoadTestConfig(
  env: Readonly<Record<string, string | undefined>>,
): LoadTestConfig {
  const rawUrl = env.LOAD_TEST_API_URL?.trim() ?? '';
  const token = env.LOAD_TEST_TOKEN?.trim() ?? '';
  const missing = [
    rawUrl === ''
      ? 'LOAD_TEST_API_URL (la URL de la app, por ejemplo https://xxxx.cloudfront.net)'
      : '',
    token === '' ? 'LOAD_TEST_TOKEN (el token del propietario)' : '',
  ].filter((name) => name !== '');
  if (missing.length > 0) {
    throw new LoadTestConfigError(`Faltan variables de entorno: ${missing.join(' y ')}.`);
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LoadTestConfigError('LOAD_TEST_API_URL no es una URL válida.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new LoadTestConfigError(
      'LOAD_TEST_API_URL debe empezar por https:// (http:// solo se admite en localhost).',
    );
  }
  return { apiUrl: url.origin, token };
}

/**
 * Nearest-rank percentile: the smallest value that is greater than or equal to
 * `p` percent of the values.
 *
 * @throws {RangeError} when there are no values or `p` is outside 0..100.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    throw new RangeError('percentile of no values');
  }
  if (!(p >= 0 && p <= 100)) {
    throw new RangeError(`percentile ${p} is outside 0..100`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

/** When to send each request: evenly spread over `spreadMs`, the first one at 0. */
export function sendOffsets(count: number, spreadMs: number): number[] {
  return Array.from({ length: count }, (_unused, index) => (index * spreadMs) / count);
}

/** A real-time message as the runner saw it: arrival time and the total of clicks it carries. */
export interface ArrivedMessage {
  /** Arrival time in milliseconds, from the same clock as the confirmations. */
  readonly at: number;
  readonly clicks: number;
}

export interface PairingResult {
  /** One latency per matched confirmation, in milliseconds, never negative. */
  readonly latencies: number[];
  /** Confirmations for which no message ever reached `base + n` clicks. */
  readonly unmatched: number;
}

/**
 * Pairs each confirmation with the message that shows it.
 *
 * The n-th 202 (counting from 1, in the order they arrived) is paired with the
 * FIRST message whose total of clicks is at least `base + n`: that message is the
 * first one that can include the click. The latency is the time from the 202 to
 * that message. A message can arrive before the 202 reaches the runner (the
 * WebSocket is faster than the HTTP response), and that counts as 0, not negative.
 *
 * `messages` must be in arrival order.
 */
export function pairLatencies(
  base: number,
  confirmations: readonly number[],
  messages: readonly ArrivedMessage[],
): PairingResult {
  const latencies: number[] = [];
  let unmatched = 0;
  confirmations.forEach((confirmedAt, index) => {
    const target = base + index + 1;
    const message = messages.find((candidate) => candidate.clicks >= target);
    if (message === undefined) {
      unmatched += 1;
    } else {
      latencies.push(Math.max(0, message.at - confirmedAt));
    }
  });
  return { latencies, unmatched };
}

/** Sum over the keys of `after` of how much each one grew since `before` (a missing key was 0). */
function growth(before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>) {
  let total = 0;
  for (const [key, value] of Object.entries(after)) {
    total += value - (before[key] ?? 0);
  }
  return total;
}

export interface Increments {
  /** Growth of the total of clicks. */
  readonly clicks: number;
  /** Growth of the total of visits. */
  readonly visits: number;
  /** Sum of the growth of the clicks of every link. */
  readonly links: number;
  /** Sum of the growth of the clicks of every minute. */
  readonly minutes: number;
  /** Sum of the growth of the clicks of every channel. */
  readonly channelClicks: number;
  /** Sum of the growth of the visits of every channel. */
  readonly channelVisits: number;
}

/** How much every counter grew between two snapshots (12.1, 12.2, 12.5). */
export function increments(before: MetricsSnapshot, after: MetricsSnapshot): Increments {
  const channels = (snapshot: MetricsSnapshot, field: 'clicks' | 'visits') =>
    Object.fromEntries(Object.entries(snapshot.channels).map(([name, c]) => [name, c[field]]));
  return {
    clicks: after.totals.clicks - before.totals.clicks,
    visits: after.totals.visits - before.totals.visits,
    links: growth(before.links, after.links),
    minutes: growth(before.minutes, after.minutes),
    channelClicks: growth(channels(before, 'clicks'), channels(after, 'clicks')),
    channelVisits: growth(channels(before, 'visits'), channels(after, 'visits')),
  };
}

/**
 * The counters in which two snapshots differ (8.8): totals, clicks per link,
 * clicks per minute and clicks and visits per channel. The feed and the server
 * time are not counters and are not compared. Empty when they agree.
 */
export function counterDifferences(a: MetricsSnapshot, b: MetricsSnapshot): string[] {
  const differences: string[] = [];
  const compare = (label: string, left: number | undefined, right: number | undefined): void => {
    if ((left ?? 0) !== (right ?? 0)) {
      differences.push(`${label}: ${left ?? 'ausente'} frente a ${right ?? 'ausente'}`);
    }
  };
  const compareRecord = (
    label: string,
    left: Readonly<Record<string, number>>,
    right: Readonly<Record<string, number>>,
  ): void => {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      compare(`${label} ${key}`, left[key], right[key]);
    }
  };

  compare('epoch', a.epoch, b.epoch);
  compare('total de clics', a.totals.clicks, b.totals.clicks);
  compare('total de visitas', a.totals.visits, b.totals.visits);
  compareRecord('clics del enlace', a.links, b.links);
  compareRecord('clics del minuto', a.minutes, b.minutes);
  for (const key of new Set([...Object.keys(a.channels), ...Object.keys(b.channels)])) {
    compare(`clics del canal ${key}`, a.channels[key]?.clicks, b.channels[key]?.clicks);
    compare(`visitas del canal ${key}`, a.channels[key]?.visits, b.channels[key]?.visits);
  }
  return differences;
}

/** One verified condition, with the requirement it comes from and what was measured. */
export interface Check {
  readonly name: string;
  readonly requirement: string;
  readonly ok: boolean;
  readonly detail: string;
}

const check = (name: string, requirement: string, ok: boolean, detail: string): Check => ({
  name,
  requirement,
  ok,
  detail,
});

const ms = (value: number): string => `${Math.round(value)} ms`;

export interface ClickRunInput {
  readonly expected: number;
  /** Metrics read before the first click and after waiting `SETTLE_MS` after the last 202. */
  readonly before: MetricsSnapshot;
  readonly after: MetricsSnapshot;
  /** HTTP status of every request, in the order they were sent. */
  readonly statuses: readonly number[];
  /** Response time of every request, in milliseconds. */
  readonly responseMs: readonly number[];
  /** Result of {@link pairLatencies} for this run. */
  readonly pairing: PairingResult;
  /** The last real-time message received, or `null` when none arrived. */
  readonly lastMessage: MetricsSnapshot | null;
}

/** Judges the click phase (12.1, 12.2, 12.4, 8.1, 8.2, 8.8). */
export function evaluateClickRun(input: ClickRunInput): Check[] {
  const { expected, before, after, statuses, responseMs, pairing, lastMessage } = input;
  const grew = increments(before, after);
  const accepted = statuses.filter((status) => status === 202).length;
  const checks: Check[] = [
    check(
      'Los clics se confirman con 202',
      '12.1',
      accepted === expected && statuses.length === expected,
      `${accepted} de ${statuses.length} enviados (esperados ${expected})`,
    ),
    check(
      'El contador total de clics sube exactamente lo enviado',
      '12.1',
      grew.clicks === expected,
      `subió ${grew.clicks}, esperado ${expected}`,
    ),
    check(
      'La suma de clics por enlace sube exactamente lo enviado',
      '12.1',
      grew.links === expected,
      `subió ${grew.links}, esperado ${expected}`,
    ),
    check(
      'La suma de clics por minuto sube exactamente lo enviado',
      '12.2',
      grew.minutes === expected,
      `subió ${grew.minutes}, esperado ${expected}`,
    ),
    check(
      'La suma de clics por canal sube exactamente lo enviado',
      '12.2',
      grew.channelClicks === expected,
      `subió ${grew.channelClicks}, esperado ${expected}`,
    ),
    check(
      'La época de las métricas no cambió durante la prueba',
      '12.1',
      before.epoch === after.epoch,
      `época ${before.epoch} y después ${after.epoch}`,
    ),
  ];

  if (responseMs.length > 0) {
    const p95 = percentile(responseMs, 95);
    checks.push(
      check(
        `p95 de la respuesta por debajo de ${MAX_HTTP_P95_MS} ms`,
        '12.4',
        p95 < MAX_HTTP_P95_MS,
        `p95 = ${ms(p95)}`,
      ),
    );
  } else {
    checks.push(check('p95 de la respuesta', '12.4', false, 'no hay respuestas medidas'));
  }

  checks.push(
    check(
      'Cada 202 llega al Panel en un mensaje',
      '8.1',
      pairing.unmatched === 0 && pairing.latencies.length > 0,
      `${pairing.latencies.length} emparejados, ${pairing.unmatched} sin mensaje`,
    ),
  );
  if (pairing.latencies.length > 0) {
    const p95 = percentile(pairing.latencies, 95);
    checks.push(
      check(
        `p95 del tiempo del 202 al mensaje por debajo de ${MAX_WS_P95_MS} ms`,
        '8.1, 8.2',
        p95 < MAX_WS_P95_MS,
        `p95 = ${ms(p95)}, máximo = ${ms(Math.max(...pairing.latencies))}`,
      ),
    );
  } else {
    checks.push(check('p95 del tiempo del 202 al mensaje', '8.1, 8.2', false, 'sin mediciones'));
  }

  if (lastMessage === null) {
    checks.push(check('El último mensaje coincide con la API', '8.8', false, 'no llegó ninguno'));
  } else {
    const differences = counterDifferences(lastMessage, after);
    checks.push(
      check(
        'El último mensaje coincide con GET /api/admin/metrics',
        '8.8',
        differences.length === 0,
        differences.length === 0
          ? 'los contadores son iguales'
          : `${differences.length} diferencias, por ejemplo: ${differences.slice(0, 3).join('; ')}`,
      ),
    );
  }
  return checks;
}

export interface VisitRunInput {
  readonly expected: number;
  readonly before: MetricsSnapshot;
  readonly after: MetricsSnapshot;
  readonly statuses: readonly number[];
}

/** Judges the visit phase (12.5). */
export function evaluateVisitRun(input: VisitRunInput): Check[] {
  const { expected, before, after, statuses } = input;
  const grew = increments(before, after);
  const accepted = statuses.filter((status) => status === 202).length;
  return [
    check(
      'Las visitas se confirman con 202',
      '12.5',
      accepted === expected && statuses.length === expected,
      `${accepted} de ${statuses.length} enviadas (esperadas ${expected})`,
    ),
    check(
      'El contador total de visitas sube exactamente lo enviado',
      '12.5',
      grew.visits === expected,
      `subió ${grew.visits}, esperado ${expected}`,
    ),
    check(
      'Los clics no cambiaron durante la fase de visitas',
      '12.5',
      grew.clicks === 0,
      `los clics subieron ${grew.clicks}`,
    ),
  ];
}
