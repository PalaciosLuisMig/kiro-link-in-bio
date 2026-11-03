import { beforeEach, describe, expect, test } from 'vitest';

import {
  ENV_VARS,
  KEEPALIVE,
  MAX_KEEPALIVE_BYTES,
  ROUTE_SELECTION_EXPRESSION,
} from '@link-in-bio/shared';

import { issueTicket } from '../../lib/domain/realtime-access.js';
import {
  DeterministicRandomSource,
  FakeClock,
  InMemoryRealtimeAccessRepository,
  RecordingLogger,
} from '../../lib/domain/testing/fakes.js';

import { composeWs } from './ws-composition.js';
import { handleWsEvent, isKeepalive, type WsDeps, type WsEvent } from './ws-routes.js';

// Tests of the `ws` Lambda routes (task 11.3): ticket absent, expired and used;
// invalid and oversized messages; and that the route selection leaves a
// keepalive on `$default`.
//
// Validates: Requirements 5.7, 5.16, 8.14, 11.5, 11.7.

const NOW_MS = 1_700_000_000_000;
const CONNECTION_ID = 'conn-abc';

interface Fixture {
  readonly deps: WsDeps;
  readonly realtime: InMemoryRealtimeAccessRepository;
  readonly clock: FakeClock;
  readonly logger: RecordingLogger;
}

function fixture(): Fixture {
  const realtime = new InMemoryRealtimeAccessRepository();
  const clock = new FakeClock(NOW_MS);
  const logger = new RecordingLogger();
  return { deps: { realtime, clock, logger }, realtime, clock, logger };
}

function event(overrides: Partial<WsEvent>): WsEvent {
  return { routeKey: '$default', connectionId: CONNECTION_ID, requestId: 'req-1', ...overrides };
}

async function newTicket(f: Fixture): Promise<string> {
  const { ticket } = await issueTicket({
    realtime: f.realtime,
    random: new DeterministicRandomSource(),
    clock: f.clock,
  });
  return ticket;
}

async function isOpen(f: Fixture): Promise<boolean> {
  const connections = await f.realtime.listConnections(f.clock.now());
  return connections.some((connection) => connection.connectionId === CONNECTION_ID);
}

describe('$connect', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });

  test('a valid ticket opens the connection (200)', async () => {
    const ticket = await newTicket(f);
    const result = await handleWsEvent(f.deps, event({ routeKey: '$connect', ticket }));
    expect(result.statusCode).toBe(200);
    expect(await isOpen(f)).toBe(true);
  });

  test('an absent or empty ticket is rejected (401)', async () => {
    for (const ticket of [undefined, '']) {
      const result = await handleWsEvent(f.deps, event({ routeKey: '$connect', ticket }));
      expect(result.statusCode).toBe(401);
    }
    expect(await isOpen(f)).toBe(false);
  });

  test('a malformed or unknown ticket is rejected (401)', async () => {
    const unknown = 'A'.repeat(43);
    for (const ticket of ['short', 'x'.repeat(44), `${'A'.repeat(42)}!`, unknown]) {
      const result = await handleWsEvent(f.deps, event({ routeKey: '$connect', ticket }));
      expect(result.statusCode).toBe(401);
    }
    expect(await isOpen(f)).toBe(false);
  });

  test('an expired ticket is rejected, also exactly at its 60 s boundary (401)', async () => {
    const ticket = await newTicket(f);
    f.clock.advance(60_000);
    const result = await handleWsEvent(f.deps, event({ routeKey: '$connect', ticket }));
    expect(result.statusCode).toBe(401);
    expect(await isOpen(f)).toBe(false);
  });

  test('a ticket just before its expiry is accepted (200)', async () => {
    const ticket = await newTicket(f);
    f.clock.advance(59_999);
    const result = await handleWsEvent(f.deps, event({ routeKey: '$connect', ticket }));
    expect(result.statusCode).toBe(200);
  });

  test('a used ticket cannot open a second connection (401)', async () => {
    const ticket = await newTicket(f);
    const first = await handleWsEvent(f.deps, event({ routeKey: '$connect', ticket }));
    const second = await handleWsEvent(
      f.deps,
      event({ routeKey: '$connect', ticket, connectionId: 'conn-other' }),
    );
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(401);
    const open = await f.realtime.listConnections(f.clock.now());
    expect(open.map((c) => c.connectionId)).toEqual([CONNECTION_ID]);
  });

  test('a storage failure rejects the connection (500) and logs no ticket', async () => {
    const ticket = await newTicket(f);
    f.realtime.consumeTicket = async () => {
      throw new Error(`dynamo down ${ticket}`);
    };
    const result = await handleWsEvent(f.deps, event({ routeKey: '$connect', ticket }));
    expect(result.statusCode).toBe(500);
    expect(f.logger.errors).toEqual([
      {
        message: 'ws_connect_failed',
        context: { code: 'ws_connect_failed', route: '$connect', requestId: 'req-1' },
      },
    ]);
    expect(JSON.stringify(f.logger)).not.toContain(ticket);
  });
});

describe('$disconnect', () => {
  test('removes the connection and answers 200', async () => {
    const f = fixture();
    const ticket = await newTicket(f);
    await handleWsEvent(f.deps, event({ routeKey: '$connect', ticket }));
    expect(await isOpen(f)).toBe(true);

    const result = await handleWsEvent(f.deps, event({ routeKey: '$disconnect' }));
    expect(result.statusCode).toBe(200);
    expect(await isOpen(f)).toBe(false);
  });

  test('an unknown connection is a no-op (200)', async () => {
    const f = fixture();
    const result = await handleWsEvent(f.deps, event({ routeKey: '$disconnect' }));
    expect(result.statusCode).toBe(200);
  });

  test('a storage failure is logged and still answers 200', async () => {
    const f = fixture();
    f.realtime.removeConnection = async () => {
      throw new Error('dynamo down');
    };
    const result = await handleWsEvent(f.deps, event({ routeKey: '$disconnect' }));
    expect(result.statusCode).toBe(200);
    expect(f.logger.errors).toHaveLength(1);
  });
});

describe('$default', () => {
  const keepalive = JSON.stringify(KEEPALIVE);

  test('a keepalive is accepted without effect (200)', async () => {
    const f = fixture();
    const result = await handleWsEvent(f.deps, event({ body: keepalive }));
    expect(result.statusCode).toBe(200);
    expect(f.logger.errors).toHaveLength(0);
    expect(f.logger.infos).toHaveLength(1);
  });

  test('invalid and non-keepalive messages are discarded without effect or log', async () => {
    const f = fixture();
    const bodies: (string | undefined)[] = [
      undefined,
      '',
      'not json',
      '{"type":"keepalive"',
      '{"type":"ping"}',
      '{"action":"keepalive"}',
      '[]',
      'null',
      '"keepalive"',
    ];
    for (const body of bodies) {
      const result = await handleWsEvent(f.deps, event({ body }));
      expect(result.statusCode).toBe(200);
    }
    expect(f.logger.infos).toHaveLength(0);
    expect(f.logger.errors).toHaveLength(0);
    expect(await f.realtime.listConnections(f.clock.now())).toHaveLength(0);
  });

  test('size limit: 128 bytes pass, 129 are discarded, counted in bytes not characters', () => {
    const padded = (bytes: number) => `{"type":"keepalive"${' '.repeat(bytes - 20)}}`;
    expect(Buffer.byteLength(padded(MAX_KEEPALIVE_BYTES))).toBe(MAX_KEEPALIVE_BYTES);
    expect(isKeepalive({ body: padded(MAX_KEEPALIVE_BYTES) })).toBe(true);
    expect(isKeepalive({ body: padded(MAX_KEEPALIVE_BYTES + 1) })).toBe(false);

    // 64 two-byte characters inside a string field: 64 characters, 128+ bytes.
    const multibyte = `{"type":"keepalive","x":"${'é'.repeat(64)}"}`;
    expect(multibyte.length).toBeLessThan(MAX_KEEPALIVE_BYTES);
    expect(Buffer.byteLength(multibyte)).toBeGreaterThan(MAX_KEEPALIVE_BYTES);
    expect(isKeepalive({ body: multibyte })).toBe(false);
  });

  test('an oversized message is never parsed', async () => {
    const f = fixture();
    const huge = `{"type":"keepalive","pad":"${'a'.repeat(100_000)}"}`;
    const result = await handleWsEvent(f.deps, event({ body: huge }));
    expect(result.statusCode).toBe(200);
    expect(f.logger.infos).toHaveLength(0);
  });

  test('a base64 body is measured and parsed after decoding', () => {
    const encoded = Buffer.from(keepalive).toString('base64');
    expect(isKeepalive({ body: encoded, isBase64Encoded: true })).toBe(true);
    const big = Buffer.from(`{"type":"keepalive","p":"${'a'.repeat(200)}"}`).toString('base64');
    expect(isKeepalive({ body: big, isBase64Encoded: true })).toBe(false);
  });

  test('the route selection expression leaves a keepalive on $default', () => {
    // `$request.body.action` routes by the `action` property of the JSON body;
    // a keepalive has none, so API Gateway falls through to `$default`.
    const property = ROUTE_SELECTION_EXPRESSION.replace('$request.body.', '');
    expect(property).toBe('action');
    expect(JSON.parse(keepalive)).not.toHaveProperty(property);
  });
});

describe('unknown route', () => {
  test('is a 400 with no effect', async () => {
    const f = fixture();
    const result = await handleWsEvent(f.deps, event({ routeKey: 'surprise' }));
    expect(result.statusCode).toBe(400);
  });
});

describe('composeWs', () => {
  test('fails fast naming the missing variable', () => {
    expect(() => composeWs({})).toThrow(ENV_VARS.tableName);
  });

  test('builds the dependencies when the table name is set', () => {
    const deps = composeWs({ [ENV_VARS.tableName]: 'LinkInBioTable' });
    expect(deps.realtime).toBeDefined();
  });
});
