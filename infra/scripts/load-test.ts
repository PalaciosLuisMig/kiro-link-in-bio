// Load test of the deployed app (task 16). It does not run in `npm test`:
//
//   LOAD_TEST_API_URL=https://xxxx.cloudfront.net LOAD_TEST_TOKEN=... npm run load-test
//
// Phase 1 sends 500 clicks spread over 10 s while a WebSocket client listens like the
// Panel does, then waits 4 s and checks the counters, the p95 of the responses, the
// p95 from each 202 to the real-time message (8.1, 8.2) and that the last message
// equals `GET /api/admin/metrics` (8.8). Phase 2 sends 500 visits (12.5).
//
// It changes the real counters of the app it points at: use a deployment for tests,
// with no other visitors while it runs. The logic that decides pass or fail is in
// `load-test-core.ts`; this file only talks to the network.

import {
  API_ROUTES,
  PREDEFINED_CHANNELS,
  metricsSnapshotSchema,
  realtimeMessageSchema,
  type MetricsSnapshot,
  type TicketResponse,
} from '@link-in-bio/shared';

import {
  LoadTestConfigError,
  REQUESTS,
  SETTLE_MS,
  SPREAD_MS,
  evaluateClickRun,
  evaluateVisitRun,
  pairLatencies,
  percentile,
  readLoadTestConfig,
  sendOffsets,
  type ArrivedMessage,
  type Check,
  type LoadTestConfig,
} from './load-test-core.js';

const REQUEST_TIMEOUT_MS = 10_000;
/** Visits only need 1 s (12.5). A little more, to be safe. */
const VISITS_SETTLE_MS = 1_500;

const say = (text = ''): void => {
  process.stdout.write(`${text}\n`);
};

const now = (): number => performance.now();
const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

interface Outcome {
  /** HTTP status, or 0 when the request failed before getting one. */
  readonly status: number;
  readonly ms: number;
  /** When the response was complete, on the same clock as the WebSocket messages. */
  readonly doneAt: number;
}

async function getJson(config: LoadTestConfig, path: string, admin: boolean): Promise<unknown> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    headers: admin ? { Authorization: `Bearer ${config.token}` } : {},
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GET ${path} respondió ${response.status}`);
  }
  return response.json();
}

async function readMetrics(config: LoadTestConfig): Promise<MetricsSnapshot> {
  return metricsSnapshotSchema.parse(await getJson(config, API_ROUTES.metrics, true));
}

async function readActiveLinkIds(config: LoadTestConfig): Promise<string[]> {
  const body = (await getJson(config, API_ROUTES.publicLinks, false)) as {
    links?: { id?: unknown }[];
  };
  const ids = (body.links ?? []).flatMap((link) => (typeof link.id === 'string' ? [link.id] : []));
  if (ids.length === 0) {
    throw new Error('No hay enlaces activos: crea al menos uno desde el Panel.');
  }
  return ids;
}

async function issueTicket(config: LoadTestConfig): Promise<TicketResponse> {
  const response = await fetch(`${config.apiUrl}${API_ROUTES.realtimeTickets}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401) {
    throw new Error('El token no es válido (401).');
  }
  if (!response.ok) {
    throw new Error(`No se pudo pedir el ticket del WebSocket (${response.status}).`);
  }
  return (await response.json()) as TicketResponse;
}

/** The WebSocket the Panel would have open, and everything it receives. */
interface Listener {
  readonly messages: ArrivedMessage[];
  last(): MetricsSnapshot | null;
  close(): void;
}

async function listen(config: LoadTestConfig): Promise<Listener> {
  const ticket = await issueTicket(config);
  const socket = new WebSocket(`${ticket.wsUrl}?ticket=${encodeURIComponent(ticket.ticket)}`);
  const messages: ArrivedMessage[] = [];
  let last: MetricsSnapshot | null = null;

  socket.addEventListener('message', (event) => {
    const at = now();
    if (typeof event.data !== 'string') {
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(event.data);
    } catch {
      return;
    }
    const parsed = realtimeMessageSchema.safeParse(json);
    if (parsed.success) {
      messages.push({ at, clicks: parsed.data.totals.clicks });
      last = parsed.data;
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('El WebSocket no se abrió a tiempo.')),
      REQUEST_TIMEOUT_MS,
    );
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('El WebSocket no se pudo abrir (ticket rechazado o URL incorrecta).'));
    });
  });

  return { messages, last: () => last, close: () => socket.close() };
}

/** Sends `count` requests spread evenly over `SPREAD_MS`, without waiting for the answers. */
async function sendSpread(
  config: LoadTestConfig,
  path: string,
  body: (index: number) => unknown,
): Promise<Outcome[]> {
  const start = now();
  return Promise.all(
    sendOffsets(REQUESTS, SPREAD_MS).map(async (offset, index) => {
      await sleep(Math.max(0, start + offset - now()));
      const sentAt = now();
      try {
        const response = await fetch(`${config.apiUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body(index)),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        await response.arrayBuffer();
        const doneAt = now();
        return { status: response.status, ms: doneAt - sentAt, doneAt };
      } catch {
        const doneAt = now();
        return { status: 0, ms: doneAt - sentAt, doneAt };
      }
    }),
  );
}

function report(title: string, checks: readonly Check[]): boolean {
  say(`\n${title}`);
  for (const item of checks) {
    say(`  ${item.ok ? 'OK    ' : 'FALLA '} [${item.requirement}] ${item.name}`);
    say(`          ${item.detail}`);
  }
  return checks.every((item) => item.ok);
}

async function main(): Promise<boolean> {
  const config = readLoadTestConfig(process.env);
  const channels = ['qr', ...PREDEFINED_CHANNELS.slice(0, 3)];

  say(`Prueba de carga contra ${config.apiUrl}`);
  say(`${REQUESTS} clics y ${REQUESTS} visitas, repartidos en ${SPREAD_MS / 1000} s cada fase.`);

  const linkIds = await readActiveLinkIds(config);
  const listener = await listen(config);
  say(`WebSocket abierto. Enlaces activos: ${linkIds.length}.`);

  try {
    // --- Phase 1: clicks ---
    const before = await readMetrics(config);
    say(`\nFase 1: enviando ${REQUESTS} clics (${SPREAD_MS / 1000} s)...`);
    const clicks = await sendSpread(config, API_ROUTES.clicks, (index) => ({
      linkId: linkIds[index % linkIds.length],
      channel: channels[index % channels.length],
    }));
    say(`Esperando ${SETTLE_MS / 1000} s tras el último 202...`);
    await sleep(SETTLE_MS);
    const afterClicks = await readMetrics(config);

    const confirmations = clicks
      .filter((outcome) => outcome.status === 202)
      .map((outcome) => outcome.doneAt)
      .sort((a, b) => a - b);
    const clicksOk = report(
      'Resultado de los clics',
      evaluateClickRun({
        expected: REQUESTS,
        before,
        after: afterClicks,
        statuses: clicks.map((outcome) => outcome.status),
        responseMs: clicks.map((outcome) => outcome.ms),
        pairing: pairLatencies(before.totals.clicks, confirmations, listener.messages),
        lastMessage: listener.last(),
      }),
    );
    const ms = clicks.map((outcome) => outcome.ms);
    say(
      `\n  Respuesta HTTP: p50 ${Math.round(percentile(ms, 50))} ms, p95 ${Math.round(percentile(ms, 95))} ms, máximo ${Math.round(Math.max(...ms))} ms`,
    );

    // --- Phase 2: visits ---
    say(`\nFase 2: enviando ${REQUESTS} visitas (${SPREAD_MS / 1000} s)...`);
    const visits = await sendSpread(config, API_ROUTES.visits, (index) => ({
      channel: channels[index % channels.length],
    }));
    await sleep(VISITS_SETTLE_MS);
    const afterVisits = await readMetrics(config);
    const visitsOk = report(
      'Resultado de las visitas',
      evaluateVisitRun({
        expected: REQUESTS,
        before: afterClicks,
        after: afterVisits,
        statuses: visits.map((outcome) => outcome.status),
      }),
    );

    return clicksOk && visitsOk;
  } finally {
    listener.close();
  }
}

try {
  const passed = await main();
  say(passed ? '\nLa prueba de carga ha pasado.' : '\nLa prueba de carga ha FALLADO.');
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  if (error instanceof LoadTestConfigError) {
    process.stderr.write(
      `\n${error.message}\n\nUso:\n  LOAD_TEST_API_URL=https://xxxx.cloudfront.net LOAD_TEST_TOKEN=... npm run load-test\n\n`,
    );
  } else {
    process.stderr.write(`\nLa prueba no pudo completarse: ${(error as Error).message}\n`);
  }
  process.exitCode = 2;
}
