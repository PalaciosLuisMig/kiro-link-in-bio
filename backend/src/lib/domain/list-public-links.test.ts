import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import type { StoredLink } from './entities.js';
import { listPublicLinks } from './list-public-links.js';
import { InMemoryLinkRepository } from './testing/fakes.js';

// Property 5: Lista pública.
//
// `listPublicLinks` is the pure use case behind `GET /api/links`: given every
// managed Link (active and inactive, in any position order with ties), it
// returns ONLY the active ones, ordered by `position` ascending, with no
// duplicate id, each projected to the public contract `{ id, title, url }`.
// The projection is the privacy boundary of Requirement 6.11: the response
// must never carry a management-only field (`position`, `active`, `clicks`,
// `createdAt`). This test exercises the invariants over arbitrary Link sets
// (Requirements 1.1, 1.3) plus the key-set guarantee (Requirement 6.11), and
// the unit cases pin the empty / all-inactive / position-tie edges.

// fast-check run count comes from the shared config (FC_NUM_RUNS); default 100.
// Domain code must not touch the Node `process` global directly (the ESLint
// boundary of `backend/src/lib/domain/` forbids it), so we read the env var off
// `globalThis` with a narrow local type, exactly like the sibling domain tests.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const numRuns = Number(env?.FC_NUM_RUNS ?? '100');

/** The exact key set a PublicLink must expose, and nothing more (6.11). */
const PUBLIC_LINK_KEYS = ['id', 'title', 'url'] as const;

/**
 * An arbitrary {@link StoredLink}. Ids are drawn from a small pool so that
 * duplicate ids are actually generated (the de-duplication invariant only bites
 * when the same id appears twice), and positions from a small pool so ties
 * between links are frequent (the ascending order must survive equal positions).
 */
const storedLinkArb: fc.Arbitrary<StoredLink> = fc.record({
  id: fc.constantFrom('a', 'b', 'c', 'd', 'e'),
  title: fc.string(),
  url: fc.webUrl(),
  // A mix of active and inactive so the filter has something to drop.
  active: fc.boolean(),
  // Small pool (including negatives and ties) so ordering is meaningfully tested.
  position: fc.integer({ min: -3, max: 6 }),
  createdAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
});

/**
 * An arbitrary set of stored links with UNIQUE ids, used when we want to reason
 * about "exactly the active ones" without the de-dup step collapsing entries.
 */
const uniqueIdLinksArb: fc.Arbitrary<StoredLink[]> = fc.uniqueArray(storedLinkArb, {
  maxLength: 10,
  selector: (link) => link.id,
});

/** Builds a seeded repository from a list of stored links. */
function repositoryOf(links: readonly StoredLink[]): InMemoryLinkRepository {
  const repository = new InMemoryLinkRepository();
  for (const link of links) {
    repository.seed(link);
  }
  return repository;
}

describe('listPublicLinks (Property 5: public list)', () => {
  // Core invariant over a UNIQUE-id set: the output ids are EXACTLY the active
  // links' ids (none omitted, none added, none duplicated) and in ascending
  // position order. Using unique ids lets us assert the exact set equality.
  // Validates: Requirements 1.1, 1.3
  test('returns exactly the active links, ordered by position ascending', async () => {
    await fc.assert(
      fc.asyncProperty(uniqueIdLinksArb, async (links) => {
        const result = await listPublicLinks(repositoryOf(links));

        // The id set equals the set of active link ids.
        const expectedActiveIds = links
          .filter((link) => link.active)
          .map((link) => link.id)
          .sort();
        const resultIds = result.map((link) => link.id).sort();
        expect(resultIds).toEqual(expectedActiveIds);

        // The positions of the returned links are non-decreasing. We look each
        // id up in the original set to recover its position.
        const positionOf = new Map(links.map((link) => [link.id, link.position]));
        for (let i = 1; i < result.length; i += 1) {
          const prev = positionOf.get(result[i - 1]!.id)!;
          const curr = positionOf.get(result[i]!.id)!;
          expect(prev).toBeLessThanOrEqual(curr);
        }
      }),
      { numRuns },
    );
  });

  // Over ARBITRARY sets (ids may repeat), the output never contains an inactive
  // link and never repeats an id. This covers the de-duplication path the
  // unique-id generator above cannot reach.
  // Validates: Requirements 1.3
  test('never includes an inactive link and never repeats an id', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(storedLinkArb, { maxLength: 20 }), async (links) => {
        const result = await listPublicLinks(repositoryOf(links));

        // Every returned id belongs to an active link in the input.
        const activeIds = new Set(links.filter((link) => link.active).map((link) => link.id));
        for (const link of result) {
          expect(activeIds.has(link.id)).toBe(true);
        }

        // No id appears twice.
        const seen = new Set(result.map((link) => link.id));
        expect(seen.size).toBe(result.length);
      }),
      { numRuns },
    );
  });

  // Each element exposes EXACTLY { id, title, url } and never a management-only
  // field. This is the Requirement 6.11 privacy boundary expressed as a runtime
  // key-set check (the type already forbids extra fields at compile time).
  // Validates: Requirements 6.11
  test('every element has exactly the keys id, title and url', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(storedLinkArb, { maxLength: 20 }), async (links) => {
        const result = await listPublicLinks(repositoryOf(links));

        for (const link of result) {
          const keys = Object.keys(link).sort();
          expect(keys).toEqual([...PUBLIC_LINK_KEYS].sort());
          // Belt and braces: the forbidden fields are truly absent.
          for (const forbidden of ['position', 'active', 'clicks', 'createdAt']) {
            expect(Object.prototype.hasOwnProperty.call(link, forbidden)).toBe(false);
          }
        }
      }),
      { numRuns },
    );
  });

  // The use case must not mutate the repository's data. We snapshot what the
  // repository returns before the call and require it to be identical after.
  // Validates: Requirements 1.1 (the list is read, not rewritten)
  test('does not mutate the repository links', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(storedLinkArb, { maxLength: 20 }), async (links) => {
        const repository = repositoryOf(links);
        const before = await repository.list();
        const beforeSnapshot = JSON.stringify(before);

        await listPublicLinks(repository);

        const after = await repository.list();
        expect(JSON.stringify(after)).toEqual(beforeSnapshot);
      }),
      { numRuns },
    );
  });

  // Carried projection fields match the source link exactly (title and url are
  // passed through unchanged for the active links that survive de-dup).
  // Validates: Requirements 1.1
  test('projects title and url straight from the active source link', async () => {
    await fc.assert(
      fc.asyncProperty(uniqueIdLinksArb, async (links) => {
        const result = await listPublicLinks(repositoryOf(links));
        const byId = new Map(links.map((link) => [link.id, link]));

        for (const publicLink of result) {
          const source = byId.get(publicLink.id)!;
          expect(publicLink.title).toBe(source.title);
          expect(publicLink.url).toBe(source.url);
        }
      }),
      { numRuns },
    );
  });

  // --- Unit cases -----------------------------------------------------------

  test('an empty repository yields an empty list', async () => {
    // Validates: Requirements 1.3
    const result = await listPublicLinks(repositoryOf([]));
    expect(result).toEqual([]);
  });

  test('all links inactive yields an empty list', async () => {
    // Validates: Requirements 1.3
    const links: StoredLink[] = [
      { id: 'a', title: 'A', url: 'https://a.example', active: false, position: 0, createdAt: 1 },
      { id: 'b', title: 'B', url: 'https://b.example', active: false, position: 1, createdAt: 2 },
    ];
    const result = await listPublicLinks(repositoryOf(links));
    expect(result).toEqual([]);
  });

  test('position ties keep every active link and a valid ascending order', async () => {
    // Validates: Requirements 1.1
    const links: StoredLink[] = [
      { id: 'a', title: 'A', url: 'https://a.example', active: true, position: 1, createdAt: 1 },
      { id: 'b', title: 'B', url: 'https://b.example', active: true, position: 1, createdAt: 2 },
      { id: 'c', title: 'C', url: 'https://c.example', active: true, position: 0, createdAt: 3 },
    ];
    const result = await listPublicLinks(repositoryOf(links));

    // The position-0 link comes first; the two tied at position 1 both appear.
    expect(result.map((link) => link.id)).toEqual(['c', 'a', 'b']);
    expect(result).toHaveLength(3);
  });

  test('mixes active and inactive, returning only the active ones in order', async () => {
    // Validates: Requirements 1.1, 1.3
    const links: StoredLink[] = [
      { id: 'a', title: 'A', url: 'https://a.example', active: true, position: 2, createdAt: 1 },
      { id: 'b', title: 'B', url: 'https://b.example', active: false, position: 0, createdAt: 2 },
      { id: 'c', title: 'C', url: 'https://c.example', active: true, position: 1, createdAt: 3 },
    ];
    const result = await listPublicLinks(repositoryOf(links));

    expect(result.map((link) => link.id)).toEqual(['c', 'a']);
    for (const link of result) {
      expect(Object.keys(link).sort()).toEqual([...PUBLIC_LINK_KEYS].sort());
    }
  });
});
