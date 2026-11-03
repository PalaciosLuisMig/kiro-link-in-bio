import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import type { StoredLink } from './entities.js';
import { NotFound } from './errors.js';
import { removeLink } from './manage-links.js';
import { parseMetricsItem } from './metrics.js';
import {
  InMemoryLinkRepository,
  InMemoryMetricsRepository,
  RecordingLogger,
} from './testing/fakes.js';

// Property 9: Eliminar un Enlace conserva el histórico (Requirement 6.5).
//
// `removeLink` deletes the `LINKS` item and THEN clears the orphan `l#<id>`
// counter from the metrics item. The property under test: removing a link
// leaves the total clicks, the per-minute clicks and the per-channel clicks
// UNCHANGED, and makes the removed link disappear from the per-link clicks,
// while every OTHER link's `l#` counter stays intact. The counter cleanup is
// best-effort: if `removeLinkCounter` fails, `removeLink` still succeeds (the
// link is gone and `getMetrics` filters orphan per-link counters), and the
// failure is logged with only the allowed fields, never the link id or any
// value (Requirements 5.18, 11.2, enforced structurally by the closed Logger
// context).

// fast-check run count comes from the shared config (FC_NUM_RUNS); default 100.
// Domain code must not touch the Node `process` global directly (the ESLint
// boundary of `backend/src/lib/domain/` forbids it), so we read the env var off
// `globalThis` with a narrow local type, exactly like the sibling domain tests.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const numRuns = Number(env?.FC_NUM_RUNS ?? '100');

/** A stored link with a deterministic shape; only `id` matters for this test. */
function storedLink(id: string, position: number): StoredLink {
  return {
    id,
    title: `link ${id}`,
    url: `https://example.com/${id}`,
    position,
    active: true,
    createdAt: 0,
  };
}

/**
 * Builds a metrics double with per-link, per-channel, per-minute and total
 * counters by replaying Clicks and Visits through the public API of the double
 * (the same atomic `ADD` the real adapter performs). Returns the double plus
 * the ids of the links that received at least one click.
 */
async function seedMetrics(
  clicks: readonly { linkId: string; channel: string; minuteSec: number }[],
  visits: readonly { channel: string }[],
): Promise<InMemoryMetricsRepository> {
  const metrics = new InMemoryMetricsRepository();
  for (const click of clicks) {
    await metrics.recordClick(click.linkId, click.channel, click.minuteSec);
  }
  for (const visit of visits) {
    await metrics.recordVisit(visit.channel);
  }
  return metrics;
}

describe('removeLink (Property 9: removing a link preserves the history)', () => {
  test('property: removing a link clears only its l#<id> counter, totals/minutes/channels and other links intact', async () => {
    // A small alphabet of ids, channels and minutes keeps collisions (and thus
    // shared counters that must survive) likely, which is where the property
    // bites. `nowMs` is fixed so `parseMetricsItem` keeps every seeded minute.
    const nowMs = 1_700_000_000_000;
    const idArb = fc.constantFrom('a', 'b', 'c', 'd');
    const channelArb = fc.constantFrom('qr', 'instagram', 'directo', 'otro');
    // Minutes within the last-60-minutes window relative to nowMs, so none is
    // dropped by `parseMetricsItem`.
    const minuteArb = fc
      .integer({ min: 0, max: 59 })
      .map((back) => Math.floor(nowMs / 60_000) * 60 - back * 60);

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ linkId: idArb, channel: channelArb, minuteSec: minuteArb }), {
          minLength: 1,
          maxLength: 40,
        }),
        fc.array(fc.record({ channel: channelArb }), { maxLength: 20 }),
        idArb,
        async (clicks, visits, idToRemove) => {
          const metrics = await seedMetrics(clicks, visits);
          const before = parseMetricsItem(await metrics.read(), nowMs);

          // The link being removed must exist in the repository so removeLink
          // reaches the counter-cleanup step (the NotFound branch is covered by
          // the unit tests below).
          const clickedIds = [...new Set(clicks.map((c) => c.linkId))];
          const links = new InMemoryLinkRepository((id) => metrics.clicksOf(id));
          clickedIds.forEach((id, index) => links.seed(storedLink(id, index)));
          // Ensure the id we remove is present even if it never got a click.
          if (!clickedIds.includes(idToRemove)) {
            links.seed(storedLink(idToRemove, clickedIds.length));
          }

          const logger = new RecordingLogger();
          await removeLink(links, metrics, logger, idToRemove);

          const after = parseMetricsItem(await metrics.read(), nowMs);

          // Totals, minutes and channels are untouched.
          expect(after.totals).toEqual(before.totals);
          expect(after.minutes).toEqual(before.minutes);
          expect(after.channels).toEqual(before.channels);

          // The removed link's per-link counter is gone...
          expect(after.links[idToRemove]).toBeUndefined();
          // ...and every OTHER per-link counter is exactly as before.
          const expectedLinks = { ...before.links };
          delete expectedLinks[idToRemove];
          expect(after.links).toEqual(expectedLinks);

          // The link item itself is deleted.
          expect(await links.get(idToRemove)).toBeNull();
        },
      ),
      { numRuns },
    );
  });

  test('unit: a missing link throws NotFound and touches no counter', async () => {
    const metrics = await seedMetrics(
      [
        { linkId: 'a', channel: 'qr', minuteSec: 28_333_333 * 60 },
        { linkId: 'b', channel: 'instagram', minuteSec: 28_333_333 * 60 },
      ],
      [{ channel: 'qr' }],
    );
    const snapshotBefore = await metrics.read();

    const links = new InMemoryLinkRepository((id) => metrics.clicksOf(id));
    links.seed(storedLink('a', 0));
    links.seed(storedLink('b', 1));

    // Spy on the two steps that must NOT run for a missing link.
    let removeCalls = 0;
    const originalRemove = links.remove.bind(links);
    links.remove = async (id: string) => {
      removeCalls += 1;
      return originalRemove(id);
    };
    let removeCounterCalls = 0;
    const originalRemoveCounter = metrics.removeLinkCounter.bind(metrics);
    metrics.removeLinkCounter = async (id: string) => {
      removeCounterCalls += 1;
      return originalRemoveCounter(id);
    };

    const logger = new RecordingLogger();
    await expect(removeLink(links, metrics, logger, 'does-not-exist')).rejects.toBeInstanceOf(
      NotFound,
    );

    expect(removeCalls).toBe(0);
    expect(removeCounterCalls).toBe(0);
    // Metrics item is byte-for-byte unchanged.
    expect(await metrics.read()).toEqual(snapshotBefore);
  });

  test('unit: removing an existing link deletes its counter and leaves another link intact', async () => {
    const nowMs = 1_700_000_000_000;
    const minuteSec = Math.floor(nowMs / 60_000) * 60;
    const metrics = await seedMetrics(
      [
        { linkId: 'keep', channel: 'qr', minuteSec },
        { linkId: 'keep', channel: 'instagram', minuteSec },
        { linkId: 'drop', channel: 'qr', minuteSec },
      ],
      [{ channel: 'qr' }],
    );
    const before = parseMetricsItem(await metrics.read(), nowMs);

    const links = new InMemoryLinkRepository((id) => metrics.clicksOf(id));
    links.seed(storedLink('keep', 0));
    links.seed(storedLink('drop', 1));

    const logger = new RecordingLogger();
    await removeLink(links, metrics, logger, 'drop');

    const after = parseMetricsItem(await metrics.read(), nowMs);

    expect(after.totals).toEqual(before.totals); // 3 clicks, 1 visit preserved
    expect(after.minutes).toEqual(before.minutes);
    expect(after.channels).toEqual(before.channels);
    expect(after.links).toEqual({ keep: 2 }); // only drop's l# disappears
    expect(after.links.drop).toBeUndefined();
    expect(await links.get('drop')).toBeNull();
    expect(await links.get('keep')).not.toBeNull();
    // No failure, so nothing is logged.
    expect(logger.errors).toHaveLength(0);
  });

  test('unit: order is get -> remove -> removeLinkCounter', async () => {
    const metrics = new InMemoryMetricsRepository();
    await metrics.recordClick('x', 'qr', 28_333_333 * 60);
    const links = new InMemoryLinkRepository((id) => metrics.clicksOf(id));
    links.seed(storedLink('x', 0));

    const order: string[] = [];
    const originalGet = links.get.bind(links);
    links.get = async (id: string) => {
      order.push('get');
      return originalGet(id);
    };
    const originalRemove = links.remove.bind(links);
    links.remove = async (id: string) => {
      order.push('remove');
      return originalRemove(id);
    };
    const originalRemoveCounter = metrics.removeLinkCounter.bind(metrics);
    metrics.removeLinkCounter = async (id: string) => {
      order.push('removeLinkCounter');
      return originalRemoveCounter(id);
    };

    const logger = new RecordingLogger();
    await removeLink(links, metrics, logger, 'x');

    expect(order).toEqual(['get', 'remove', 'removeLinkCounter']);
  });

  test('unit: a failing removeLinkCounter still succeeds, logs only allowed fields, link is gone', async () => {
    const nowMs = 1_700_000_000_000;
    const minuteSec = Math.floor(nowMs / 60_000) * 60;
    const metrics = await seedMetrics(
      [
        { linkId: 'keep', channel: 'qr', minuteSec },
        { linkId: 'drop', channel: 'instagram', minuteSec },
      ],
      [],
    );

    const links = new InMemoryLinkRepository((id) => metrics.clicksOf(id));
    links.seed(storedLink('keep', 0));
    links.seed(storedLink('drop', 1));

    // Arm the injected failure on the metrics double's removeLinkCounter.
    metrics.removeCounterFailure.armOnce();

    const logger = new RecordingLogger();
    // Must NOT throw: best-effort cleanup.
    await expect(removeLink(links, metrics, logger, 'drop')).resolves.toBeUndefined();

    // The link item is deleted even though the counter cleanup failed.
    expect(await links.get('drop')).toBeNull();

    // The failure was logged exactly once, on the error channel.
    expect(logger.errors).toHaveLength(1);
    const entry = logger.errors[0]!;
    expect(entry.context).toBeDefined();
    // Only allowed keys may appear; crucially the link id is NEVER present.
    const allowedKeys = new Set(['code', 'route', 'requestId']);
    for (const key of Object.keys(entry.context ?? {})) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    // The id and the message must not leak the removed link's id.
    const serialized = JSON.stringify({ message: entry.message, context: entry.context });
    expect(serialized.includes('drop')).toBe(false);
  });

  test('unit: logContext route/requestId are forwarded, still without the id', async () => {
    const metrics = new InMemoryMetricsRepository();
    await metrics.recordClick('drop', 'qr', 28_333_333 * 60);
    const links = new InMemoryLinkRepository((id) => metrics.clicksOf(id));
    links.seed(storedLink('drop', 0));
    metrics.removeCounterFailure.armOnce();

    const logger = new RecordingLogger();
    await removeLink(links, metrics, logger, 'drop', {
      route: '/api/links/:id',
      requestId: 'req-123',
    });

    expect(logger.errors).toHaveLength(1);
    const context = logger.errors[0]!.context ?? {};
    expect(context.route).toBe('/api/links/:id');
    expect(context.requestId).toBe('req-123');
    expect(JSON.stringify(context).includes('drop')).toBe(false);
  });
});
