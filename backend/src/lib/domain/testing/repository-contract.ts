// Reusable repository contract battery.
//
// `runRepositoryContract` registers a suite of assertions that any
// implementation of the domain repositories must satisfy, regardless of whether
// it is an in-memory double (validated here in task 4) or the real DynamoDB
// adapter driven by a fake client (reused in task 9). Because both must honour
// the SAME port contracts (Liskov substitution, design "Capas y regla de
// dependencias"), one battery guards them both.
//
// The battery is PARAMETERIZED by a factory: the caller passes a function that
// builds a fresh set of repositories per test, so the suite stays isolated and
// works with whatever construction each implementation needs. It registers its
// own `describe`/`test` blocks, so a test file calls it at top level.
//
// This file lives under `backend/src/lib/domain/`, so it is pure domain code
// apart from the Vitest test APIs it uses to register the suite. It imports
// Vitest (not AWS, Node, or the DOM), which is correct for a test helper.

import { describe, expect, test } from 'vitest';

import type { StoredEvent, StoredLink } from '../entities.js';
import type {
  EventRepository,
  LinkRepository,
  MetricsRepository,
  RealtimeAccessRepository,
} from '../ports.js';
import { eventSortKey, ttlFromMs } from './fakes.js';

/**
 * The repositories under contract. A factory returns one fresh instance of each
 * per test. The metrics and link repositories are expected to be wired so that
 * `LinkRepository.list()` reflects the per-link counters held by the metrics
 * repository (the real adapter joins the `LINKS` item and the `l#<id>`
 * attribute); the in-memory doubles are wired the same way by the factory.
 */
export interface ContractRepositories {
  readonly links: LinkRepository;
  readonly metrics: MetricsRepository;
  readonly events: EventRepository;
  readonly access: RealtimeAccessRepository;
}

/** Builds a fresh, isolated set of repositories for one test. */
export type RepositoryFactory = () => ContractRepositories;

/** Builds a stored link with sensible defaults, overridable per field. */
function makeLink(overrides: Partial<StoredLink> & Pick<StoredLink, 'id'>): StoredLink {
  return {
    title: 'Title',
    url: 'https://example.com',
    position: 0,
    active: true,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * Registers the full contract suite under a `describe(name)` block. Call it at
 * the top level of a test file, passing a factory that builds the repositories
 * for the implementation under test.
 *
 * @param name label for the `describe` block (e.g. "in-memory doubles").
 * @param factory builds a fresh set of repositories for each test.
 */
export function runRepositoryContract(name: string, factory: RepositoryFactory): void {
  describe(`repository contract: ${name}`, () => {
    // --- LinkRepository -----------------------------------------------------

    describe('LinkRepository', () => {
      test('get returns null for a missing link and the link after create', async () => {
        const { links } = factory();
        expect(await links.get('missing')).toBeNull();

        const link = makeLink({ id: 'a' });
        await links.create(link);

        const got = await links.get('a');
        expect(got).not.toBeNull();
        expect(got?.id).toBe('a');
        expect(got?.title).toBe('Title');
      });

      test('list returns every link, active and inactive', async () => {
        const { links } = factory();
        await links.create(makeLink({ id: 'a', position: 0, active: true }));
        await links.create(makeLink({ id: 'b', position: 1, active: false }));

        const all = await links.list();
        expect(all.map((l) => l.id).sort()).toEqual(['a', 'b']);
      });

      test('update changes fields, keeps id and position, rejects a missing link', async () => {
        const { links } = factory();
        await links.create(makeLink({ id: 'a', title: 'Old', position: 3, active: true }));

        const updated = await links.update('a', { title: 'New', active: false });
        expect(updated.title).toBe('New');
        expect(updated.active).toBe(false);
        expect(updated.id).toBe('a');
        expect(updated.position).toBe(3);

        await expect(links.update('missing', { title: 'x' })).rejects.toMatchObject({
          code: 'not_found',
        });
      });

      test('create rejects a duplicate id', async () => {
        const { links } = factory();
        await links.create(makeLink({ id: 'a' }));
        await expect(links.create(makeLink({ id: 'a' }))).rejects.toBeInstanceOf(Error);
      });

      test('remove deletes the link', async () => {
        const { links } = factory();
        await links.create(makeLink({ id: 'a' }));
        await links.remove('a');
        expect(await links.get('a')).toBeNull();
      });

      test('reorder accepts an exact permutation and rewrites positions', async () => {
        const { links } = factory();
        await links.create(makeLink({ id: 'a', position: 0 }));
        await links.create(makeLink({ id: 'b', position: 1 }));
        await links.create(makeLink({ id: 'c', position: 2 }));

        await links.reorder(['c', 'a', 'b']);

        const byId = new Map((await links.list()).map((l) => [l.id, l.position]));
        expect(byId.get('c')).toBe(0);
        expect(byId.get('a')).toBe(1);
        expect(byId.get('b')).toBe(2);
      });

      test('reorder rejects a non-permutation and leaves positions unchanged', async () => {
        const { links } = factory();
        await links.create(makeLink({ id: 'a', position: 0 }));
        await links.create(makeLink({ id: 'b', position: 1 }));

        await expect(links.reorder(['a'])).rejects.toMatchObject({ code: 'validation' });
        await expect(links.reorder(['a', 'b', 'c'])).rejects.toMatchObject({ code: 'validation' });
        await expect(links.reorder(['a', 'a'])).rejects.toMatchObject({ code: 'validation' });

        const byId = new Map((await links.list()).map((l) => [l.id, l.position]));
        expect(byId.get('a')).toBe(0);
        expect(byId.get('b')).toBe(1);
      });
    });

    // --- MetricsRepository --------------------------------------------------

    describe('MetricsRepository', () => {
      test('recordClick adds the four counters atomically', async () => {
        const { metrics } = factory();
        await metrics.recordClick('link-1', 'instagram', 1_700_000_040);

        const item = await metrics.read();
        expect(item['totalClicks']).toBe(1);
        expect(item['l#link-1']).toBe(1);
        expect(item['cc#instagram']).toBe(1);
        expect(item['m#1700000040']).toBe(1);
      });

      test('recordVisit adds the two counters', async () => {
        const { metrics } = factory();
        await metrics.recordVisit('qr');

        const item = await metrics.read();
        expect(item['totalVisits']).toBe(1);
        expect(item['cv#qr']).toBe(1);
      });

      test('repeated records accumulate', async () => {
        const { metrics } = factory();
        await metrics.recordClick('x', 'qr', 60);
        await metrics.recordClick('x', 'qr', 60);
        const item = await metrics.read();
        expect(item['totalClicks']).toBe(2);
        expect(item['l#x']).toBe(2);
      });

      test('reset replaces the item with an empty one carrying the new epoch', async () => {
        const { metrics } = factory();
        await metrics.recordClick('x', 'qr', 60);
        await metrics.reset(1_700_000_000_000);

        const item = await metrics.read();
        expect(item['epoch']).toBe(1_700_000_000_000);
        expect(item['totalClicks']).toBeUndefined();
        expect(item['l#x']).toBeUndefined();
      });

      test('removeLinkCounter drops only the per-link counter', async () => {
        const { metrics } = factory();
        await metrics.recordClick('x', 'qr', 60);
        await metrics.recordVisit('qr');
        await metrics.removeLinkCounter('x');

        const item = await metrics.read();
        expect(item['l#x']).toBeUndefined();
        // Totals, minutes and channels are untouched (Requirement 6.5).
        expect(item['totalClicks']).toBe(1);
        expect(item['m#60']).toBe(1);
        expect(item['cc#qr']).toBe(1);
        expect(item['cv#qr']).toBe(1);
      });
    });

    // --- EventRepository ----------------------------------------------------

    describe('EventRepository', () => {
      test('latest returns newest-first and honours the sinceSortKey floor', async () => {
        const { events } = factory();
        const base = 1_700_000_000_000;
        const e1: StoredEvent = { id: 'e1', type: 'click', channel: 'qr', ts: base + 1000 };
        const e2: StoredEvent = { id: 'e2', type: 'visit', channel: 'qr', ts: base + 2000 };
        const e3: StoredEvent = { id: 'e3', type: 'click', channel: 'qr', ts: base + 3000 };
        await events.put(e1);
        await events.put(e2);
        await events.put(e3);

        const newest = await events.latest(eventSortKey(0, ''), 20);
        expect(newest.map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);

        // Floor at e1's sort key excludes e1 and anything at or below it.
        const afterFloor = await events.latest(eventSortKey(base + 1000, 'e1'), 20);
        expect(afterFloor.map((e) => e.id)).toEqual(['e3', 'e2']);
      });

      test('latest respects the limit', async () => {
        const { events } = factory();
        for (let i = 0; i < 25; i += 1) {
          await events.put({
            id: `e${i}`,
            type: 'click',
            channel: 'qr',
            ts: 1_700_000_000_000 + i,
          });
        }
        const newest = await events.latest(eventSortKey(0, ''), 20);
        expect(newest).toHaveLength(20);
      });
    });

    // --- RealtimeAccessRepository ------------------------------------------

    describe('RealtimeAccessRepository', () => {
      test('a stored ticket is consumed at most once', async () => {
        const { access } = factory();
        const now = 1_700_000_000_000;
        await access.storeTicket('hash-1', now + 60_000);

        expect(await access.consumeTicket('hash-1', now + 1000)).toBe(true);
        // A second consumption of the same ticket must fail.
        expect(await access.consumeTicket('hash-1', now + 1000)).toBe(false);
      });

      test('an unknown ticket is rejected', async () => {
        const { access } = factory();
        expect(await access.consumeTicket('nope', 1_700_000_000_000)).toBe(false);
      });

      test('an expired ticket is rejected, including exactly at expiry', async () => {
        const { access } = factory();
        const expiresAt = 1_700_000_060_000;
        await access.storeTicket('hash-exp', expiresAt);
        // now === expiresAt counts as expired (strict `expiresAt > now`).
        expect(await access.consumeTicket('hash-exp', expiresAt)).toBe(false);

        await access.storeTicket('hash-late', expiresAt);
        expect(await access.consumeTicket('hash-late', expiresAt + 1)).toBe(false);
      });

      test('listConnections returns only non-expired connections', async () => {
        const { access } = factory();
        const createdAt = 1_700_000_000_000;
        await access.addConnection({ connectionId: 'c1', createdAt });

        // Within the 24 h TTL window: present.
        expect((await access.listConnections(createdAt + 1000)).map((c) => c.connectionId)).toEqual(
          ['c1'],
        );

        // Past the 24 h TTL: filtered out even if not yet deleted.
        const ttlMs = ttlFromMs(createdAt) * 1000;
        expect(await access.listConnections(ttlMs + 1000)).toEqual([]);
      });

      test('removeConnection deletes the connection', async () => {
        const { access } = factory();
        const createdAt = 1_700_000_000_000;
        await access.addConnection({ connectionId: 'c1', createdAt });
        await access.removeConnection('c1');
        expect(await access.listConnections(createdAt + 1000)).toEqual([]);
      });
    });
  });
}
