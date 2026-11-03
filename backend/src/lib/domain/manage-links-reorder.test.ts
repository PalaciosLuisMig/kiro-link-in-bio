import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import type { Link, StoredLink } from './entities.js';
import { ValidationError } from './errors.js';
import { reorderLinks } from './manage-links.js';
import type { LinkRepository } from './ports.js';
import { InMemoryLinkRepository } from './testing/fakes.js';

// Property 7: Reordenación.
//
// `reorderLinks` is the pure use case behind `PUT /api/links/order`: given the
// existing managed Links and a proposed order of ids, it accepts the order IF
// AND ONLY IF the ids are an EXACT permutation of the existing ids (same ids,
// none missing, none extra, none duplicated). When accepted, it renumbers the
// Links to positions 0..n-1 in exactly the received order (Requirement 6.4).
// When rejected, it throws a `ValidationError` and leaves every position (and
// every other field) unchanged (Requirement 6.13). A reorder also never loses,
// duplicates, or otherwise alters a Link's title, url, active flag, clicks, id
// or createdAt: only `position` moves.
//
// This file exercises the invariants over arbitrary Link sets and arbitrary
// permutations / non-permutations (Requirements 6.4, 6.13), plus unit cases
// that pin the clear edges, and one test that a `ValidationError` surfaced by
// the repository's `reorder` (the adapter's translation of a cancelled
// `TransactWriteItems` / `TransactionCanceledException`, Requirement 6.13) is
// propagated as-is rather than turned into a 500.

// fast-check run count comes from the shared config (FC_NUM_RUNS); default 100.
// Domain code must not touch the Node `process` global directly (the ESLint
// boundary of `backend/src/lib/domain/` forbids it), so we read the env var off
// `globalThis` with a narrow local type, exactly like the sibling domain tests.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const numRuns = Number(env?.FC_NUM_RUNS ?? '100');

/** The fields that a reorder must NEVER change (everything except `position`). */
const INVARIANT_LINK_KEYS = ['id', 'title', 'url', 'active', 'clicks', 'createdAt'] as const;

/**
 * An arbitrary {@link StoredLink} with a UNIQUE id drawn later via a pool, so a
 * seeded repository has a well-defined set of ids to permute. `position` is
 * arbitrary (including negatives, gaps and duplicates across links) so the
 * renumbering has something real to normalize to 0..n-1.
 */
function storedLinkArb(id: string): fc.Arbitrary<StoredLink> {
  return fc.record({
    id: fc.constant(id),
    title: fc.string(),
    url: fc.webUrl(),
    active: fc.boolean(),
    position: fc.integer({ min: -5, max: 50 }),
    createdAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  });
}

/**
 * An arbitrary non-empty set of stored links with unique ids. Ids come from a
 * fixed pool (`id-0`..`id-11`) of which a random subset is taken, so the set
 * size varies while every id is distinct.
 */
const linkSetArb: fc.Arbitrary<StoredLink[]> = fc
  .uniqueArray(fc.integer({ min: 0, max: 11 }), { minLength: 1, maxLength: 10 })
  .chain((indices) => fc.tuple(...indices.map((i) => storedLinkArb(`id-${i}`))));

/** Builds a seeded repository from a list of stored links. */
function repositoryOf(links: readonly StoredLink[]): InMemoryLinkRepository {
  const repository = new InMemoryLinkRepository();
  for (const link of links) {
    repository.seed(link);
  }
  return repository;
}

/** A snapshot of every stored field keyed by id, for before/after comparison. */
async function snapshotById(repository: LinkRepository): Promise<Map<string, Link>> {
  const links = await repository.list();
  const byId = new Map<string, Link>();
  for (const link of links) {
    byId.set(link.id, link);
  }
  return byId;
}

describe('reorderLinks (Property 7: reorder)', () => {
  // An exact permutation is accepted: positions become 0..n-1 EXACTLY in the
  // received order, so listing by position reproduces `orderedIds`.
  // Validates: Requirements 6.4
  test('an exact permutation renumbers positions to 0..n-1 in that order', async () => {
    await fc.assert(
      fc.asyncProperty(
        linkSetArb.chain((links) =>
          fc.constant(links).chain(() =>
            fc
              .shuffledSubarray(
                links.map((link) => link.id),
                { minLength: links.length, maxLength: links.length },
              )
              .map((orderedIds) => ({ links, orderedIds })),
          ),
        ),
        async ({ links, orderedIds }) => {
          const repository = repositoryOf(links);
          await reorderLinks(repository, orderedIds);

          const after = await repository.list();
          // Positions are exactly 0..n-1.
          const positions = [...after.map((link) => link.position)].sort((a, b) => a - b);
          expect(positions).toEqual(orderedIds.map((_, index) => index));

          // Listing by ascending position reproduces the received order.
          const byPosition = [...after]
            .sort((a, b) => a.position - b.position)
            .map((link) => link.id);
          expect(byPosition).toEqual([...orderedIds]);
        },
      ),
      { numRuns },
    );
  });

  // Bijection: the multiset of ids is unchanged and no Link loses or changes any
  // field other than `position`. Nothing is lost or duplicated.
  // Validates: Requirements 6.4
  test('a reorder preserves every link and changes only its position', async () => {
    await fc.assert(
      fc.asyncProperty(
        linkSetArb.chain((links) =>
          fc
            .shuffledSubarray(
              links.map((link) => link.id),
              { minLength: links.length, maxLength: links.length },
            )
            .map((orderedIds) => ({ links, orderedIds })),
        ),
        async ({ links, orderedIds }) => {
          const repository = repositoryOf(links);
          const before = await snapshotById(repository);

          await reorderLinks(repository, orderedIds);

          const after = await repository.list();
          // The multiset of ids is identical (same count, same ids).
          expect([...after.map((link) => link.id)].sort()).toEqual([...before.keys()].sort());
          expect(after.length).toBe(before.size);

          // Every non-position field is preserved for each id.
          for (const link of after) {
            const original = before.get(link.id);
            expect(original).toBeDefined();
            for (const key of INVARIANT_LINK_KEYS) {
              expect(link[key]).toEqual(original![key as keyof typeof original]);
            }
          }
        },
      ),
      { numRuns },
    );
  });

  // Anything other than an exact permutation (missing / extra / duplicated /
  // unknown id) is rejected with ValidationError and leaves positions unchanged.
  // Validates: Requirements 6.13
  test('a non-permutation is rejected with ValidationError and changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        linkSetArb.chain((links) => {
          // `linkSetArb` always yields at least one link, so `ids[0]` exists.
          const ids = links.map((link) => link.id);
          const firstId = ids[0] as string;
          // Four ways to break the exact-permutation invariant.
          const brokenArb: fc.Arbitrary<string[]> = fc.oneof(
            // Missing: drop one id.
            fc.constant<string[]>(ids.slice(1)),
            // Extra: add an id that does not exist.
            fc.constant<string[]>([...ids, 'ghost-id']),
            // Duplicated: repeat an existing id (length now differs, so it is a
            // non-permutation even on single-element sets).
            fc.constant<string[]>([...ids, firstId]),
            // Unknown substitution: replace the first id with one that is absent.
            fc.constant<string[]>(['ghost-id', ...ids.slice(1)]),
          );
          return brokenArb.map((orderedIds) => ({ links, orderedIds }));
        }),
        async ({ links, orderedIds }) => {
          const repository = repositoryOf(links);
          const before = await snapshotById(repository);

          await expect(reorderLinks(repository, orderedIds)).rejects.toBeInstanceOf(
            ValidationError,
          );

          // Positions (and all other fields) are untouched after the rejection.
          const after = await snapshotById(repository);
          expect(after).toEqual(before);
        },
      ),
      { numRuns },
    );
  });

  // Idempotence: reordering with the CURRENT position order leaves everything
  // as it already is (positions already normalized stay put).
  // Validates: Requirements 6.4
  test('reordering with the current order is idempotent', async () => {
    await fc.assert(
      fc.asyncProperty(linkSetArb, async (links) => {
        const repository = repositoryOf(links);
        // First normalize to 0..n-1 in current-position order.
        const initialOrder = [...links]
          .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))
          .map((link) => link.id);
        await reorderLinks(repository, initialOrder);
        const afterFirst = await snapshotById(repository);

        // Reorder again with the now-current order: nothing should change.
        const currentOrder = (await repository.list())
          .sort((a, b) => a.position - b.position)
          .map((link) => link.id);
        await reorderLinks(repository, currentOrder);
        const afterSecond = await snapshotById(repository);

        expect(afterSecond).toEqual(afterFirst);
      }),
      { numRuns },
    );
  });

  // A ValidationError raised by the repository's `reorder` itself — the adapter
  // translating a cancelled TransactWriteItems / TransactionCanceledException
  // (Requirement 6.13) — is propagated as-is, never swallowed or turned into a
  // 500. The in-memory fake does not expose a reorder-failure switch, so a
  // minimal LinkRepository double models the cancelled transaction: its `list`
  // makes `orderedIds` a valid permutation (so the use case's own check passes)
  // while its `reorder` rejects with ValidationError.
  // Validates: Requirements 6.13
  test('propagates a ValidationError thrown by the repository reorder', async () => {
    const existing: StoredLink[] = [
      { id: 'a', title: 'A', url: 'https://a.example', position: 0, active: true, createdAt: 1 },
      { id: 'b', title: 'B', url: 'https://b.example', position: 1, active: true, createdAt: 2 },
    ];
    const cancelled = new ValidationError('transaction cancelled', ['ids']);

    const repository: LinkRepository = {
      async list(): Promise<Link[]> {
        return existing.map((link) => ({ ...link, clicks: 0 }));
      },
      get(): Promise<Link | null> {
        throw new Error('not used');
      },
      create(): Promise<void> {
        throw new Error('not used');
      },
      update(): Promise<Link> {
        throw new Error('not used');
      },
      remove(): Promise<void> {
        throw new Error('not used');
      },
      async reorder(): Promise<void> {
        throw cancelled;
      },
    };

    await expect(reorderLinks(repository, ['b', 'a'])).rejects.toBe(cancelled);
  });
});

describe('reorderLinks unit cases', () => {
  // Validates: Requirements 6.4
  test('reverses the order of two links to positions 0 and 1', async () => {
    const repository = repositoryOf([
      { id: 'a', title: 'A', url: 'https://a.example', position: 0, active: true, createdAt: 1 },
      { id: 'b', title: 'B', url: 'https://b.example', position: 1, active: true, createdAt: 2 },
    ]);

    await reorderLinks(repository, ['b', 'a']);

    const after = (await repository.list()).sort((x, y) => x.position - y.position);
    expect(after.map((link) => link.id)).toEqual(['b', 'a']);
    expect(after.map((link) => link.position)).toEqual([0, 1]);
  });

  // Validates: Requirements 6.4
  test('normalizes sparse positions to 0..n-1 in the received order', async () => {
    const repository = repositoryOf([
      { id: 'x', title: 'X', url: 'https://x.example', position: 7, active: true, createdAt: 1 },
      { id: 'y', title: 'Y', url: 'https://y.example', position: 42, active: false, createdAt: 2 },
      { id: 'z', title: 'Z', url: 'https://z.example', position: -3, active: true, createdAt: 3 },
    ]);

    await reorderLinks(repository, ['z', 'x', 'y']);

    const after = (await repository.list()).sort((a, b) => a.position - b.position);
    expect(after.map((link) => link.id)).toEqual(['z', 'x', 'y']);
    expect(after.map((link) => link.position)).toEqual([0, 1, 2]);
  });

  // Validates: Requirements 6.13
  test('rejects a missing id and leaves positions unchanged', async () => {
    const repository = repositoryOf([
      { id: 'a', title: 'A', url: 'https://a.example', position: 0, active: true, createdAt: 1 },
      { id: 'b', title: 'B', url: 'https://b.example', position: 1, active: true, createdAt: 2 },
    ]);

    await expect(reorderLinks(repository, ['a'])).rejects.toBeInstanceOf(ValidationError);

    const after = (await repository.list()).sort((a, b) => a.position - b.position);
    expect(after.map((link) => link.id)).toEqual(['a', 'b']);
    expect(after.map((link) => link.position)).toEqual([0, 1]);
  });

  // Validates: Requirements 6.13
  test('rejects an unknown id and leaves positions unchanged', async () => {
    const repository = repositoryOf([
      { id: 'a', title: 'A', url: 'https://a.example', position: 0, active: true, createdAt: 1 },
      { id: 'b', title: 'B', url: 'https://b.example', position: 1, active: true, createdAt: 2 },
    ]);

    await expect(reorderLinks(repository, ['a', 'c'])).rejects.toBeInstanceOf(ValidationError);

    const after = (await repository.list()).sort((a, b) => a.position - b.position);
    expect(after.map((link) => link.position)).toEqual([0, 1]);
  });

  // Validates: Requirements 6.13
  test('rejects a duplicated id and leaves positions unchanged', async () => {
    const repository = repositoryOf([
      { id: 'a', title: 'A', url: 'https://a.example', position: 0, active: true, createdAt: 1 },
      { id: 'b', title: 'B', url: 'https://b.example', position: 1, active: true, createdAt: 2 },
    ]);

    await expect(reorderLinks(repository, ['a', 'a'])).rejects.toBeInstanceOf(ValidationError);

    const after = (await repository.list()).sort((a, b) => a.position - b.position);
    expect(after.map((link) => link.id)).toEqual(['a', 'b']);
    expect(after.map((link) => link.position)).toEqual([0, 1]);
  });

  // Validates: Requirements 6.4 (empty set is a trivially valid permutation)
  test('accepts an empty order on an empty link set', async () => {
    const repository = repositoryOf([]);
    await expect(reorderLinks(repository, [])).resolves.toBeUndefined();
    expect(await repository.list()).toEqual([]);
  });

  // Validates: Requirements 6.4 (single link maps to position 0)
  test('normalizes a single link to position 0', async () => {
    const repository = repositoryOf([
      { id: 'solo', title: 'S', url: 'https://s.example', position: 9, active: true, createdAt: 1 },
    ]);

    await reorderLinks(repository, ['solo']);

    const [only] = await repository.list();
    expect(only?.position).toBe(0);
  });
});
