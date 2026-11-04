import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { issueTicket, openConnection } from './realtime-access.js';
import {
  DeterministicRandomSource,
  FakeClock,
  InMemoryRealtimeAccessRepository,
} from './testing/fakes.js';

// Property 16: Tickets de un solo uso.
//
// A Ticket_Conexión is single-use: no matter how many requests present the SAME
// ticket, AT MOST ONE Conexión is ever accepted for it, even if several arrive
// "at once" (Requirement 5.16). A ticket that was never issued, or that is
// presented at or after its 60 s expiry, is rejected (Requirements 5.7, 5.16).
//
// The guarantee rests on `RealtimeAccessRepository.consumeTicket` being atomic:
// it deletes the stored hash and returns `true` only if the hash existed and
// `expiresAt > now`. The in-memory double (`InMemoryRealtimeAccessRepository`)
// mirrors that atomicity for this single-threaded test by deleting the hash
// before deciding, so a second consume for the same hash necessarily fails.
// There is no real wall-clock time here: a `FakeClock` is set explicitly and a
// `DeterministicRandomSource` makes every issued ticket reproducible.
//
// Validates: Requirements 5.7, 5.16.

// fast-check run count comes from the shared config (FC_NUM_RUNS); default 100.
// Domain code must not touch the Node `process` global directly (the ESLint
// boundary of `backend/src/lib/domain/` forbids it), so we read the env var off
// `globalThis` with a narrow local type, exactly like the sibling domain tests.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const numRuns = Number(env?.FC_NUM_RUNS ?? '100');

/** Lifetime of a ticket in milliseconds (60 s), as `issueTicket` stamps it. */
const TICKET_TTL_MS = 60_000;

/**
 * Issues a ticket at `issueMs` from a deterministic seed, and returns the
 * plaintext ticket plus the repository it was stored in, ready for a batch of
 * `openConnection` attempts.
 */
async function issueAt(issueMs: number, seed: number) {
  const realtime = new InMemoryRealtimeAccessRepository();
  const clock = new FakeClock(issueMs);
  const issued = await issueTicket({
    realtime,
    random: new DeterministicRandomSource(seed),
    clock,
  });
  return { realtime, issued };
}

describe('openConnection (Property 16: single-use tickets)', () => {
  // Exactly one of N attempts with the SAME ticket succeeds, and it is the
  // FIRST one to reach the repository; every later attempt fails. This holds
  // whether the attempts run one after another or are launched together, so
  // "several requests with the same ticket arriving at once" still open at most
  // one connection. Each winning attempt stores its own connection id, so the
  // count of stored connections equals the count of successes (exactly one).
  // Validates: Requirements 5.7, 5.16
  test('at most one of many attempts with the same ticket succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A valid moment to attempt within the ticket's window ([0, TTL)), the
        // number of competing attempts, the random seed, and whether we run the
        // attempts sequentially or concurrently.
        fc.integer({ min: 0, max: TICKET_TTL_MS - 1 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 255 }),
        fc.boolean(),
        async (offsetMs, attempts, seed, concurrent) => {
          const issueMs = 1_700_000_000_000;
          const { realtime, issued } = await issueAt(issueMs, seed);

          const clock = new FakeClock(issueMs + offsetMs);
          const deps = { realtime, clock };
          const ids = Array.from({ length: attempts }, (_, i) => `conn-${i}`);

          let results: boolean[];
          if (concurrent) {
            // All attempts launched together; the double consumes atomically,
            // so only one can win regardless of interleaving.
            results = await Promise.all(ids.map((id) => openConnection(deps, issued.ticket, id)));
          } else {
            results = [];
            for (const id of ids) {
              results.push(await openConnection(deps, issued.ticket, id));
            }
          }

          const successes = results.filter((ok) => ok).length;
          expect(successes).toBe(1);

          // The ticket is consumed: no hash remains, so no further attempt could
          // ever succeed.
          expect(realtime.hasTicket(hashOf(issued.ticket))).toBe(false);

          // Exactly one connection was stored (the single winner).
          const connections = await realtime.listConnections(clock.now());
          expect(connections).toHaveLength(1);
        },
      ),
      { numRuns },
    );
  });

  // The 60 s boundary: a ticket is accepted once strictly BEFORE its expiry
  // (`now < expiresAt`) and rejected at or after it (`now >= expiresAt`). The
  // exact boundary `now === expiresAt` is the critical case and must be
  // rejected (`expiresAt > now` is required).
  // Validates: Requirement 5.16
  test('a ticket is accepted strictly before expiry and rejected at or after it', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Offset from the issue instant, spanning well before to well after the
        // 60 s expiry, including the exact boundary at TICKET_TTL_MS.
        fc.integer({ min: 0, max: 2 * TICKET_TTL_MS }),
        fc.integer({ min: 0, max: 255 }),
        async (offsetMs, seed) => {
          const issueMs = 1_700_000_000_000;
          const { realtime, issued } = await issueAt(issueMs, seed);
          expect(issued.expiresAt).toBe(issueMs + TICKET_TTL_MS);

          const clock = new FakeClock(issueMs + offsetMs);
          const opened = await openConnection({ realtime, clock }, issued.ticket, 'conn-1');

          // Accepted iff strictly before expiry; `offsetMs === TICKET_TTL_MS`
          // (now === expiresAt) falls on the rejected side.
          const expected = offsetMs < TICKET_TTL_MS;
          expect(opened).toBe(expected);
        },
      ),
      { numRuns },
    );
  });

  // The exact boundary, pinned as a concrete case so the "now === expiresAt is
  // rejected" rule is unmissable and a regression that flips `>` to `>=` fails
  // here immediately. Just before the boundary, the same ticket is accepted.
  // Validates: Requirement 5.16
  test('now === expiresAt is rejected; one millisecond earlier is accepted', async () => {
    const issueMs = 1_700_000_000_000;

    // Exactly at the boundary: rejected, and the ticket stays consumable...
    const atBoundary = await issueAt(issueMs, 1);
    const boundaryClock = new FakeClock(atBoundary.issued.expiresAt);
    expect(
      await openConnection(
        { realtime: atBoundary.realtime, clock: boundaryClock },
        atBoundary.issued.ticket,
        'conn-boundary',
      ),
    ).toBe(false);
    // An atomic consume at the boundary still removes the hash, so the ticket
    // is spent even though no connection opened; no connection was stored.
    expect(await atBoundary.realtime.listConnections(boundaryClock.now())).toHaveLength(0);

    // ...one millisecond earlier: accepted exactly once.
    const justBefore = await issueAt(issueMs, 1);
    const beforeClock = new FakeClock(justBefore.issued.expiresAt - 1);
    expect(
      await openConnection(
        { realtime: justBefore.realtime, clock: beforeClock },
        justBefore.issued.ticket,
        'conn-before',
      ),
    ).toBe(true);
    expect(await justBefore.realtime.listConnections(beforeClock.now())).toHaveLength(1);
  });
});

// --- helpers ---------------------------------------------------------------

/** SHA-256 hex of a ticket, the only value the repository ever stores. */
function hashOf(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}
