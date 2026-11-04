import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { closeConnection, issueTicket, openConnection } from './realtime-access.js';
import {
  DeterministicRandomSource,
  FakeClock,
  InMemoryRealtimeAccessRepository,
} from './testing/fakes.js';

// Unit tests for the real-time access use cases (task 7.2):
// `issueTicket`, `openConnection` and `closeConnection`.
//
// The one-time property (Property 16) is covered by its own task (7.3); here we
// pin the concrete behaviour: a ticket is 32 random bytes as base64url, only
// its SHA-256 hash (hex) is stored, the ticket is valid for 60 s, the boundary
// `now === expiresAt` is rejected, a malformed ticket is rejected before any
// repository call, and closing a connection removes it.
//
// Validates: Requirements 5.7, 5.15, 5.16, 5.17, 11.5, 11.6, 11.7.

/** The base64url encoding of the 32 bytes the deterministic source yields from a seed. */
function expectedTicket(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = (seed + i) % 256;
  }
  return Buffer.from(bytes).toString('base64url');
}

/** SHA-256 hex of a ticket, the only value the repository should ever store. */
function sha256Hex(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

function makeIssueDeps(startMs: number, seed = 0) {
  return {
    realtime: new InMemoryRealtimeAccessRepository(),
    random: new DeterministicRandomSource(seed),
    clock: new FakeClock(startMs),
  };
}

describe('issueTicket', () => {
  // The ticket is 32 bytes encoded as base64url: 43 characters from the
  // base64url alphabet, with no padding.
  // Validates: Requirement 5.15
  test('produces a 43-char base64url ticket from 32 random bytes', async () => {
    const deps = makeIssueDeps(1_700_000_000_000, 7);

    const issued = await issueTicket(deps);

    expect(issued.ticket).toBe(expectedTicket(7));
    expect(issued.ticket).toHaveLength(43);
    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]+$/);
    // No standard-base64 characters or padding leaked in.
    expect(issued.ticket).not.toMatch(/[+/=]/);
  });

  // The returned expiry is exactly 60 s after `now`.
  // Validates: Requirement 5.17
  test('returns an expiry 60 s after now', async () => {
    const now = 1_700_000_000_000;
    const deps = makeIssueDeps(now);

    const issued = await issueTicket(deps);

    expect(issued.expiresAt).toBe(now + 60_000);
  });

  // Only the SHA-256 hash (hex) is stored, with the same expiry; the plaintext
  // ticket is never persisted.
  // Validates: Requirements 5.15, 5.17
  test('stores only the SHA-256 hash of the ticket, never the ticket', async () => {
    const now = 1_700_000_000_000;
    const deps = makeIssueDeps(now, 3);

    const issued = await issueTicket(deps);

    const hash = sha256Hex(issued.ticket);
    expect(deps.realtime.hasTicket(hash)).toBe(true);
    // The plaintext ticket is not a stored key.
    expect(deps.realtime.hasTicket(issued.ticket)).toBe(false);
  });

  // Two issues from different random bytes yield different tickets and hashes.
  // Validates: Requirement 5.15
  test('issues distinct tickets for distinct random bytes', async () => {
    const realtime = new InMemoryRealtimeAccessRepository();
    const clock = new FakeClock(1_700_000_000_000);

    const first = await issueTicket({ realtime, random: new DeterministicRandomSource(0), clock });
    const second = await issueTicket({
      realtime,
      random: new DeterministicRandomSource(50),
      clock,
    });

    expect(first.ticket).not.toBe(second.ticket);
  });
});

describe('openConnection', () => {
  // A freshly issued, unexpired ticket opens a connection and is consumed.
  // Validates: Requirements 5.7, 11.6
  test('opens a connection for a valid ticket and consumes it', async () => {
    const now = 1_700_000_000_000;
    const deps = makeIssueDeps(now, 11);
    const issued = await issueTicket(deps);

    const opened = await openConnection(
      { realtime: deps.realtime, clock: deps.clock },
      issued.ticket,
      'conn-1',
    );

    expect(opened).toBe(true);
    // The ticket hash is gone (consumed), so it cannot be used again.
    expect(deps.realtime.hasTicket(sha256Hex(issued.ticket))).toBe(false);
    // The connection is stored and not yet expired.
    const connections = await deps.realtime.listConnections(now);
    expect(connections.map((c) => c.connectionId)).toContain('conn-1');
  });

  // The same ticket cannot open a second connection.
  // Validates: Requirement 5.16
  test('rejects a ticket that was already used', async () => {
    const deps = makeIssueDeps(1_700_000_000_000);
    const issued = await issueTicket(deps);
    const openDeps = { realtime: deps.realtime, clock: deps.clock };

    expect(await openConnection(openDeps, issued.ticket, 'conn-1')).toBe(true);
    expect(await openConnection(openDeps, issued.ticket, 'conn-2')).toBe(false);

    const connections = await deps.realtime.listConnections(deps.clock.now());
    expect(connections.map((c) => c.connectionId)).toEqual(['conn-1']);
  });

  // A ticket presented after its 60 s window is rejected.
  // Validates: Requirement 5.16
  test('rejects an expired ticket', async () => {
    const now = 1_700_000_000_000;
    const deps = makeIssueDeps(now);
    const issued = await issueTicket(deps);

    deps.clock.set(issued.expiresAt + 1);
    const opened = await openConnection(
      { realtime: deps.realtime, clock: deps.clock },
      issued.ticket,
      'conn-late',
    );

    expect(opened).toBe(false);
  });

  // The boundary `now === expiresAt` counts as expired and is rejected.
  // Validates: Requirement 5.16
  test('rejects a ticket exactly at its expiry boundary (now === expiresAt)', async () => {
    const now = 1_700_000_000_000;
    const deps = makeIssueDeps(now);
    const issued = await issueTicket(deps);

    deps.clock.set(issued.expiresAt);
    const opened = await openConnection(
      { realtime: deps.realtime, clock: deps.clock },
      issued.ticket,
      'conn-boundary',
    );

    expect(opened).toBe(false);
    // No connection was stored.
    expect(await deps.realtime.listConnections(now)).toHaveLength(0);
  });

  // A malformed ticket is rejected by length/alphabet validation BEFORE any
  // repository lookup, so it can never consume a stored ticket.
  // Validates: Requirement 11.5
  test('rejects malformed tickets without touching the repository', async () => {
    const now = 1_700_000_000_000;
    const deps = makeIssueDeps(now, 21);
    const issued = await issueTicket(deps);
    const hash = sha256Hex(issued.ticket);
    const openDeps = { realtime: deps.realtime, clock: deps.clock };

    const malformed = [
      '', // empty
      'short', // too short
      issued.ticket.slice(0, 42), // one char short
      `${issued.ticket}a`, // one char too long
      `${'+'.repeat(43)}`, // right length, forbidden standard-base64 char
      `${'='.repeat(43)}`, // right length, padding char
      `${issued.ticket.slice(0, 42)}+`, // 43 chars but a '+' sneaks in
    ];

    for (const value of malformed) {
      expect(await openConnection(openDeps, value, 'conn-x')).toBe(false);
    }

    // The real, valid ticket is untouched: it was never consumed by the noise.
    expect(deps.realtime.hasTicket(hash)).toBe(true);
    // And no connection was opened by any malformed attempt.
    expect(await deps.realtime.listConnections(now)).toHaveLength(0);
  });

  // An unknown but well-formed ticket (never issued) is rejected.
  // Validates: Requirement 5.7
  test('rejects a well-formed ticket that was never issued', async () => {
    const deps = makeIssueDeps(1_700_000_000_000);

    const unknown = expectedTicket(99);
    const opened = await openConnection(
      { realtime: deps.realtime, clock: deps.clock },
      unknown,
      'conn-unknown',
    );

    expect(opened).toBe(false);
  });
});

describe('closeConnection', () => {
  // Closing a connection removes it so it is no longer listed.
  // Validates: Requirement 11.7
  test('removes the connection', async () => {
    const now = 1_700_000_000_000;
    const deps = makeIssueDeps(now);
    const issued = await issueTicket(deps);
    const openDeps = { realtime: deps.realtime, clock: deps.clock };
    await openConnection(openDeps, issued.ticket, 'conn-1');

    await closeConnection(deps.realtime, 'conn-1');

    expect(await deps.realtime.listConnections(now)).toHaveLength(0);
  });

  // Closing an unknown connection id is a harmless no-op (idempotent).
  // Validates: Requirement 11.7
  test('closing an unknown connection id is a no-op', async () => {
    const realtime = new InMemoryRealtimeAccessRepository();

    await expect(closeConnection(realtime, 'never-opened')).resolves.toBeUndefined();
  });
});
