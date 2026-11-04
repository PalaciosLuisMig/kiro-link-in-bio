import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import type { StoredEvent } from './entities.js';
import type { EventRepository } from './ports.js';
import { registerClick, registerVisit } from './register-activity.js';
import {
  FakeClock,
  InMemoryLinkRepository,
  InMemoryMetricsRepository,
  RecordingLogger,
  SequentialIdGenerator,
} from './testing/fakes.js';

// Property 18 (part 1): Solo se guardan datos permitidos.
//
// Whatever `registerClick` and `registerVisit` hand to the repositories (the
// activity event and the metrics-item attributes) must contain ONLY the
// whitelisted attributes of the design. By construction neither use case
// receives an IP, a User-Agent or a Referer, so a privacy leak could only
// happen if an extra field slipped into the stored event or the metrics item.
// The HTTP side (arbitrary request headers) is covered later, in task 10.5.
//
// Validates: Requirements 11.1, 11.2.

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const numRuns = Number(env?.FC_NUM_RUNS ?? '100');

/** The ONLY attribute names a stored event may carry. */
const ALLOWED_EVENT_KEYS = new Set(['id', 'type', 'channel', 'title', 'ts']);

/** Attribute-name prefixes/keys the metrics item may carry (design whitelist). */
function isAllowedMetricsKey(key: string): boolean {
  return (
    key === 'totalClicks' ||
    key === 'totalVisits' ||
    key === 'epoch' ||
    key.startsWith('l#') ||
    key.startsWith('cc#') ||
    key.startsWith('cv#') ||
    key.startsWith('m#')
  );
}

/** An EventRepository double that captures every event handed to `put`. */
class CapturingEventRepository implements EventRepository {
  readonly puts: StoredEvent[] = [];
  async put(event: StoredEvent): Promise<void> {
    this.puts.push(event);
  }
  async latest(): Promise<StoredEvent[]> {
    return [];
  }
}

function makeDeps(nowMs: number): {
  links: InMemoryLinkRepository;
  metrics: InMemoryMetricsRepository;
  events: CapturingEventRepository;
  clock: FakeClock;
  ids: SequentialIdGenerator;
  logger: RecordingLogger;
} {
  const metrics = new InMemoryMetricsRepository();
  const links = new InMemoryLinkRepository((id) => metrics.clicksOf(id));
  return {
    links,
    metrics,
    events: new CapturingEventRepository(),
    clock: new FakeClock(nowMs),
    ids: new SequentialIdGenerator('ev'),
    logger: new RecordingLogger(),
  };
}

describe('registerClick / registerVisit (Property 18 part 1: only allowed data)', () => {
  const nowArb = fc.integer({ min: 1_600_000_000_000, max: 2_000_000_000_000 });
  // Arbitrary raw channel values, including unusual ones, to be sure nothing but
  // the normalized channel reaches storage.
  const rawChannelArb = fc.oneof(
    fc.constant(undefined),
    fc.string(),
    fc.constantFrom('Instagram', 'qr', 'weird value', '日本語'),
  );

  // A click stores an event with only the allowed keys and bumps only allowed
  // metrics attributes.
  // Validates: Requirements 11.1, 11.2
  test('a click stores only whitelisted event keys and metrics attributes', async () => {
    await fc.assert(
      fc.asyncProperty(nowArb, rawChannelArb, async (nowMs, rawChannel) => {
        const deps = makeDeps(nowMs);
        deps.links.seed({
          id: 'link-1',
          title: 'Mi enlace',
          url: 'https://example.com',
          position: 0,
          active: true,
          createdAt: nowMs - 1000,
        });

        await registerClick(deps, 'link-1', rawChannel);

        // The stored event carries only the allowed keys.
        expect(deps.events.puts).toHaveLength(1);
        const event = deps.events.puts[0]!;
        for (const key of Object.keys(event)) {
          expect(ALLOWED_EVENT_KEYS.has(key)).toBe(true);
        }
        expect(event.type).toBe('click');

        // The metrics item carries only allowed attributes.
        const item = await deps.metrics.read();
        for (const key of Object.keys(item)) {
          expect(isAllowedMetricsKey(key)).toBe(true);
        }
      }),
      { numRuns },
    );
  });

  // A visit stores an event with only the allowed keys (and NO title) and bumps
  // only allowed metrics attributes.
  // Validates: Requirements 11.1, 11.2
  test('a visit stores only whitelisted event keys (no title) and metrics attributes', async () => {
    await fc.assert(
      fc.asyncProperty(nowArb, rawChannelArb, async (nowMs, rawChannel) => {
        const deps = makeDeps(nowMs);

        await registerVisit(deps, rawChannel);

        expect(deps.events.puts).toHaveLength(1);
        const event = deps.events.puts[0]!;
        for (const key of Object.keys(event)) {
          expect(ALLOWED_EVENT_KEYS.has(key)).toBe(true);
        }
        expect(event.type).toBe('visit');
        // A visit event never carries a title.
        expect('title' in event).toBe(false);

        const item = await deps.metrics.read();
        for (const key of Object.keys(item)) {
          expect(isAllowedMetricsKey(key)).toBe(true);
        }
        // A visit only bumps totalVisits and a cv# channel counter.
        expect(item['totalClicks']).toBeUndefined();
        expect(item['totalVisits']).toBe(1);
      }),
      { numRuns },
    );
  });

  // Unit case: the event title for a click is exactly the links current title,
  // and no other field is present.
  test('a click event keeps the links current title and nothing else', async () => {
    const deps = makeDeps(1_700_000_000_000);
    deps.links.seed({
      id: 'l1',
      title: 'Current Title',
      url: 'https://example.com',
      position: 0,
      active: true,
      createdAt: 1,
    });

    await registerClick(deps, 'l1', 'qr');

    const event = deps.events.puts[0]!;
    expect(event.title).toBe('Current Title');
    expect(new Set(Object.keys(event))).toEqual(new Set(['id', 'type', 'channel', 'title', 'ts']));
  });
});
