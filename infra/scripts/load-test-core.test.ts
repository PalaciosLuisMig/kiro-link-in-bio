import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import type { MetricsSnapshot } from '@link-in-bio/shared';

import {
  MAX_HTTP_P95_MS,
  MAX_WS_P95_MS,
  REQUESTS,
  SPREAD_MS,
  counterDifferences,
  evaluateClickRun,
  evaluateVisitRun,
  increments,
  LoadTestConfigError,
  pairLatencies,
  percentile,
  readLoadTestConfig,
  sendOffsets,
  type ClickRunInput,
} from './load-test-core.js';

const MINUTE = '2026-01-01T10:00:00.000Z';

function snapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    epoch: 0,
    serverTime: MINUTE,
    totals: { clicks: 10, visits: 4 },
    links: { a: 6, b: 4 },
    minutes: { [MINUTE]: 10 },
    channels: { qr: { clicks: 10, visits: 4 } },
    events: [],
    ...overrides,
  };
}

/** The snapshot after `n` more clicks, spread over two links, a channel and a minute. */
function afterClicks(before: MetricsSnapshot, n: number): MetricsSnapshot {
  return {
    ...before,
    totals: { ...before.totals, clicks: before.totals.clicks + n },
    links: { a: (before.links.a ?? 0) + n - 1, b: (before.links.b ?? 0) + 1 },
    minutes: { [MINUTE]: (before.minutes[MINUTE] ?? 0) + n },
    channels: {
      qr: {
        clicks: (before.channels.qr?.clicks ?? 0) + n,
        visits: before.channels.qr?.visits ?? 0,
      },
    },
  };
}

describe('percentile', () => {
  test('nearest rank: the p95 of 1..100 is 95 and the p100 is the maximum', () => {
    const values = Array.from({ length: 100 }, (_unused, index) => index + 1);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile(values, 50)).toBe(50);
  });

  test('does not depend on the order and does not change its input', () => {
    const values = [9, 1, 5, 3, 7];
    expect(percentile(values, 60)).toBe(5);
    expect(values).toEqual([9, 1, 5, 3, 7]);
  });

  test('p0 is the minimum, and one value is every percentile', () => {
    expect(percentile([4, 2, 8], 0)).toBe(2);
    expect(percentile([42], 95)).toBe(42);
  });

  test('refuses no values and a percentile outside 0..100', () => {
    expect(() => percentile([], 95)).toThrow(RangeError);
    expect(() => percentile([1], -1)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
    expect(() => percentile([1], Number.NaN)).toThrow(RangeError);
  });

  test('property: the result is one of the values and at least p percent are not above it', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 0, max: 100 }),
        (values, p) => {
          const result = percentile(values, p);
          expect(values).toContain(result);
          const notAbove = values.filter((value) => value <= result).length;
          expect(notAbove / values.length).toBeGreaterThanOrEqual(p / 100);
        },
      ),
    );
  });
});

describe('sendOffsets', () => {
  test('spreads the requests evenly, the first at 0 and the last before the end', () => {
    expect(sendOffsets(4, 1_000)).toEqual([0, 250, 500, 750]);
    const offsets = sendOffsets(REQUESTS, SPREAD_MS);
    expect(offsets).toHaveLength(REQUESTS);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBeLessThan(SPREAD_MS);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });
});

describe('pairLatencies', () => {
  test('pairs the n-th 202 with the first message that reaches base + n', () => {
    const result = pairLatencies(
      100,
      [1_000, 1_010, 1_020],
      [
        { at: 1_300, clicks: 101 },
        { at: 1_900, clicks: 103 },
      ],
    );
    // 1st 202 -> message at 1300 (101 >= 101); 2nd and 3rd -> message at 1900 (103 >= 102, 103).
    expect(result.latencies).toEqual([300, 890, 880]);
    expect(result.unmatched).toBe(0);
  });

  test('uses the FIRST message that qualifies, not a later one', () => {
    const result = pairLatencies(
      0,
      [10],
      [
        { at: 50, clicks: 1 },
        { at: 90, clicks: 5 },
      ],
    );
    expect(result.latencies).toEqual([40]);
  });

  test('a message that arrives before its 202 counts as 0, never negative', () => {
    const result = pairLatencies(0, [500], [{ at: 200, clicks: 1 }]);
    expect(result.latencies).toEqual([0]);
  });

  test('the base is excluded: messages that only show the old clicks do not pair', () => {
    const result = pairLatencies(100, [10], [{ at: 20, clicks: 100 }]);
    expect(result.latencies).toEqual([]);
    expect(result.unmatched).toBe(1);
  });

  test('a confirmation that no message reached is counted as unmatched', () => {
    const result = pairLatencies(0, [1, 2, 3], [{ at: 10, clicks: 2 }]);
    expect(result.latencies).toHaveLength(2);
    expect(result.unmatched).toBe(1);
  });

  test('with no messages, every confirmation is unmatched', () => {
    expect(pairLatencies(0, [1, 2], [])).toEqual({ latencies: [], unmatched: 2 });
  });

  test('property: matched + unmatched is the number of confirmations, and no latency is negative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.array(fc.integer({ min: 0, max: 5_000 }), { maxLength: 40 }),
        fc.array(
          fc.record({
            at: fc.integer({ min: 0, max: 5_000 }),
            clicks: fc.integer({ min: 0, max: 100 }),
          }),
          { maxLength: 20 },
        ),
        (base, confirmations, messages) => {
          const result = pairLatencies(base, confirmations, messages);
          expect(result.latencies.length + result.unmatched).toBe(confirmations.length);
          expect(result.latencies.every((latency) => latency >= 0)).toBe(true);
        },
      ),
    );
  });
});

describe('increments', () => {
  test('measures how much each family of counters grew', () => {
    const before = snapshot();
    const grew = increments(before, afterClicks(before, 500));
    expect(grew).toMatchObject({
      clicks: 500,
      visits: 0,
      links: 500,
      minutes: 500,
      channelClicks: 500,
      channelVisits: 0,
    });
  });

  test('a link, minute or channel that did not exist before counts from 0', () => {
    const before = snapshot({ links: {}, minutes: {}, channels: {} });
    const after = snapshot({
      links: { x: 3 },
      minutes: { [MINUTE]: 2, '2026-01-01T10:01:00.000Z': 1 },
      channels: { web: { clicks: 3, visits: 2 } },
    });
    const grew = increments(before, after);
    expect(grew.links).toBe(3);
    expect(grew.minutes).toBe(3);
    expect(grew.channelClicks).toBe(3);
    expect(grew.channelVisits).toBe(2);
  });

  test('visits are measured apart from clicks', () => {
    const before = snapshot();
    const after = snapshot({
      totals: { clicks: 10, visits: 504 },
      channels: { qr: { clicks: 10, visits: 504 } },
    });
    const grew = increments(before, after);
    expect(grew.visits).toBe(500);
    expect(grew.channelVisits).toBe(500);
    expect(grew.clicks).toBe(0);
  });
});

describe('counterDifferences', () => {
  test('equal counters give no differences, even if the feed and the clock differ', () => {
    const a = snapshot();
    const b = snapshot({
      serverTime: '2026-01-01T10:00:09.000Z',
      events: [{ id: 'e', type: 'visit', channel: 'qr', at: MINUTE }],
    });
    expect(counterDifferences(a, b)).toEqual([]);
  });

  test('a missing key and a zero are the same', () => {
    expect(counterDifferences(snapshot({ links: { a: 6, b: 4, c: 0 } }), snapshot())).toEqual([]);
  });

  test.each([
    ['epoch', snapshot({ epoch: 5 }), 'epoch'],
    ['total clicks', snapshot({ totals: { clicks: 11, visits: 4 } }), 'total de clics'],
    ['total visits', snapshot({ totals: { clicks: 10, visits: 5 } }), 'total de visitas'],
    ['a link', snapshot({ links: { a: 7, b: 4 } }), 'clics del enlace a'],
    ['a minute', snapshot({ minutes: { [MINUTE]: 11 } }), 'clics del minuto'],
    [
      'channel clicks',
      snapshot({ channels: { qr: { clicks: 11, visits: 4 } } }),
      'clics del canal qr',
    ],
    [
      'channel visits',
      snapshot({ channels: { qr: { clicks: 10, visits: 5 } } }),
      'visitas del canal qr',
    ],
    [
      'a new channel',
      snapshot({ channels: { qr: { clicks: 10, visits: 4 }, web: { clicks: 1, visits: 0 } } }),
      'clics del canal web',
    ],
  ])('finds a difference in %s', (_name, other, expected) => {
    const differences = counterDifferences(snapshot(), other);
    expect(differences).toHaveLength(1);
    expect(differences[0]).toContain(expected);
  });
});

describe('evaluateClickRun', () => {
  const before = snapshot();
  const after = afterClicks(before, REQUESTS);

  /** A run in which everything is right. */
  function good(overrides: Partial<ClickRunInput> = {}): ClickRunInput {
    return {
      expected: REQUESTS,
      before,
      after,
      statuses: Array<number>(REQUESTS).fill(202),
      responseMs: Array<number>(REQUESTS).fill(80),
      pairing: { latencies: Array<number>(REQUESTS).fill(900), unmatched: 0 },
      lastMessage: after,
      ...overrides,
    };
  }

  const failed = (input: ClickRunInput): string[] =>
    evaluateClickRun(input)
      .filter((item) => !item.ok)
      .map((item) => item.requirement);

  test('a run in which everything is right passes every check', () => {
    const checks = evaluateClickRun(good());
    expect(checks.every((item) => item.ok)).toBe(true);
    // Every requirement of the task is covered.
    const covered = new Set(checks.flatMap((item) => item.requirement.split(', ')));
    for (const requirement of ['8.1', '8.2', '8.8', '12.1', '12.2', '12.4']) {
      expect(covered).toContain(requirement);
    }
  });

  test('a click that did not get a 202 fails', () => {
    const statuses = Array<number>(REQUESTS).fill(202);
    statuses[7] = 429;
    expect(failed(good({ statuses }))).toEqual(['12.1']);
  });

  test('one click less than sent fails the total, the links, the minutes and the channels', () => {
    const lost = afterClicks(before, REQUESTS - 1);
    expect(failed(good({ after: lost, lastMessage: lost }))).toEqual([
      '12.1',
      '12.1',
      '12.2',
      '12.2',
    ]);
  });

  test('one click more than sent also fails (it is exact, not "at least")', () => {
    const extra = afterClicks(before, REQUESTS + 1);
    expect(failed(good({ after: extra, lastMessage: extra }))).toHaveLength(4);
  });

  test('a change of epoch during the run fails', () => {
    const reset = { ...after, epoch: 99 };
    expect(failed(good({ after: reset, lastMessage: reset }))).toContain('12.1');
  });

  test('the HTTP p95 must be under 1 s: 5 % slow responses are tolerated, 6 % are not', () => {
    const slow = (count: number): number[] => [
      ...Array<number>(count).fill(MAX_HTTP_P95_MS + 500),
      ...Array<number>(REQUESTS - count).fill(50),
    ];
    expect(failed(good({ responseMs: slow(25) }))).toEqual([]);
    expect(failed(good({ responseMs: slow(26) }))).toEqual(['12.4']);
  });

  test('exactly 1000 ms is not "under 1 s"', () => {
    expect(failed(good({ responseMs: Array<number>(REQUESTS).fill(MAX_HTTP_P95_MS) }))).toEqual([
      '12.4',
    ]);
  });

  test('without any measured response the HTTP check fails instead of passing', () => {
    expect(failed(good({ responseMs: [] }))).toEqual(['12.4']);
  });

  test('the real-time p95 must be under 3 s', () => {
    const slow = (count: number): number[] => [
      ...Array<number>(count).fill(MAX_WS_P95_MS + 1),
      ...Array<number>(REQUESTS - count).fill(500),
    ];
    expect(failed(good({ pairing: { latencies: slow(25), unmatched: 0 } }))).toEqual([]);
    expect(failed(good({ pairing: { latencies: slow(26), unmatched: 0 } }))).toEqual(['8.1, 8.2']);
    expect(
      failed(
        good({ pairing: { latencies: Array<number>(REQUESTS).fill(MAX_WS_P95_MS), unmatched: 0 } }),
      ),
    ).toEqual(['8.1, 8.2']);
  });

  test('a 202 that never reached the Panel fails, even if the p95 is good', () => {
    expect(
      failed(good({ pairing: { latencies: Array<number>(499).fill(100), unmatched: 1 } })),
    ).toEqual(['8.1']);
  });

  test('with no real-time messages at all, both real-time checks and 8.8 fail', () => {
    expect(
      failed(good({ pairing: { latencies: [], unmatched: REQUESTS }, lastMessage: null })),
    ).toEqual(['8.1', '8.1, 8.2', '8.8']);
  });

  test('8.8: a last message that differs from the API fails and says where', () => {
    const stale = afterClicks(before, REQUESTS - 3);
    const checks = evaluateClickRun(good({ lastMessage: stale }));
    const item = checks.find((candidate) => candidate.requirement === '8.8');
    expect(item?.ok).toBe(false);
    expect(item?.detail).toContain('total de clics');
  });
});

describe('evaluateVisitRun', () => {
  const before = snapshot();
  const after = snapshot({
    totals: { clicks: 10, visits: 4 + REQUESTS },
    channels: { qr: { clicks: 10, visits: 4 + REQUESTS } },
  });
  const statuses = Array<number>(REQUESTS).fill(202);

  test('passes when the visits grew exactly and the clicks did not move', () => {
    expect(
      evaluateVisitRun({ expected: REQUESTS, before, after, statuses }).every((item) => item.ok),
    ).toBe(true);
  });

  test('fails with one visit less, one more, a non-202 or a moved click counter', () => {
    const run = (input: Partial<Parameters<typeof evaluateVisitRun>[0]>) =>
      evaluateVisitRun({ expected: REQUESTS, before, after, statuses, ...input }).filter(
        (item) => !item.ok,
      );
    expect(
      run({ after: snapshot({ totals: { clicks: 10, visits: 4 + REQUESTS - 1 } }) }),
    ).toHaveLength(1);
    expect(
      run({ after: snapshot({ totals: { clicks: 10, visits: 4 + REQUESTS + 1 } }) }),
    ).toHaveLength(1);
    expect(run({ statuses: [...statuses.slice(1), 500] })).toHaveLength(1);
    expect(run({ after: snapshot({ totals: { clicks: 11, visits: 4 + REQUESTS } }) })).toHaveLength(
      1,
    );
  });
});

describe('readLoadTestConfig', () => {
  const TOKEN = 't'.repeat(40);

  test('reads the URL and the token, and keeps only the origin of the URL', () => {
    expect(
      readLoadTestConfig({
        LOAD_TEST_API_URL: ' https://abc.cloudfront.net/panel.html ',
        LOAD_TEST_TOKEN: ` ${TOKEN}
`,
      }),
    ).toEqual({ apiUrl: 'https://abc.cloudfront.net', token: TOKEN });
  });

  test('a missing variable is an error that names it, and never the token', () => {
    expect(() => readLoadTestConfig({})).toThrow('LOAD_TEST_API_URL');
    expect(() => readLoadTestConfig({})).toThrow('LOAD_TEST_TOKEN');
    expect(() => readLoadTestConfig({ LOAD_TEST_API_URL: 'https://a.io' })).toThrow(
      'LOAD_TEST_TOKEN',
    );
    expect(() => readLoadTestConfig({ LOAD_TEST_TOKEN: TOKEN })).toThrow('LOAD_TEST_API_URL');
  });

  test('refuses an invalid URL and http:// outside this machine', () => {
    for (const url of ['no es una url', 'http://abc.cloudfront.net', 'ftp://abc.io']) {
      expect(() => readLoadTestConfig({ LOAD_TEST_API_URL: url, LOAD_TEST_TOKEN: TOKEN })).toThrow(
        LoadTestConfigError,
      );
    }
  });

  test('allows http:// on this machine, to try the script against npm run dev', () => {
    for (const url of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
      expect(readLoadTestConfig({ LOAD_TEST_API_URL: url, LOAD_TEST_TOKEN: TOKEN }).apiUrl).toBe(
        new URL(url).origin,
      );
    }
  });

  test('the message never repeats the token', () => {
    let message = '';
    try {
      readLoadTestConfig({ LOAD_TEST_API_URL: 'http://evil.example', LOAD_TEST_TOKEN: TOKEN });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(TOKEN);
  });
});
