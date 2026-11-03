// Pure domain use cases: real-time access (connection tickets and Panel
// connections).
//
// This module is domain logic. It takes its ports (`RealtimeAccessRepository`,
// `RandomSource`, `Clock`) as injected dependencies and never imports the AWS
// SDK, a Lambda handler, or an adapter; the composition roots wire the real
// adapters and the tests wire the in-memory doubles (`testing/fakes.ts`). It
// does use `node:crypto` for SHA-256 hashing, which the domain ESLint boundary
// allows (only the AWS SDK, handlers and adapters are forbidden here): the
// cryptographic hash is an intrinsic part of the ticket rule, not an outbound
// side effect, so it stays in the domain rather than behind a port.
//
// Privacy and single-use guarantees (Requirements 5.7, 5.15, 5.16, 5.17, 11.5,
// 11.6, 11.7):
// - A ticket is 32 cryptographically-random bytes encoded as base64url (>= 128
//   bits). Only its SHA-256 hash (hex) is ever stored, never the ticket itself.
// - A ticket is valid for 60 s and is consumed ATOMICALLY exactly once; at the
//   boundary `now === expiresAt` it is already expired and rejected.
// - A connection is identified by a transient technical id that does not
//   identify a person and expires automatically (24 h TTL, set by the adapter).

import { createHash } from 'node:crypto';

import type { Clock, RandomSource, RealtimeAccessRepository } from './ports.js';

/** Number of random bytes drawn for a ticket (32 bytes = 256 bits >= 128). */
const TICKET_BYTES = 32;

/** Lifetime of a connection ticket in milliseconds (60 s, Requirement 5.17). */
const TICKET_TTL_MS = 60_000;

/**
 * The exact length (characters) of a base64url encoding of 32 bytes with no
 * padding: `ceil(32 / 3) * 4 - 2 = 43`. `openConnection` checks this length
 * before hashing so a malformed ticket never reaches the repository.
 */
const TICKET_LENGTH = 43;

/**
 * The base64url alphabet (RFC 4648 §5): `A-Z`, `a-z`, `0-9`, `-` and `_`, with
 * no padding. Anchored to the whole string so any other character (including
 * standard-base64 `+`/`/` or `=` padding) is rejected.
 */
const TICKET_ALPHABET = /^[A-Za-z0-9_-]+$/;

/**
 * The value `issueTicket` returns: the plaintext ticket and its expiry (Unix
 * ms). The admin handler (task 10.4) adds `wsUrl` to build the full
 * `TicketResponse`; the domain does not know the WebSocket URL.
 */
export interface IssuedTicket {
  /** The plaintext ticket (base64url), returned to the Panel exactly once. */
  readonly ticket: string;
  /** When the ticket stops being valid (Unix ms), 60 s after issue. */
  readonly expiresAt: number;
}

/** The ports `issueTicket` needs. */
export interface IssueTicketDeps {
  readonly realtime: RealtimeAccessRepository;
  readonly random: RandomSource;
  readonly clock: Clock;
}

/** The ports `openConnection` needs. */
export interface OpenConnectionDeps {
  readonly realtime: RealtimeAccessRepository;
  readonly clock: Clock;
}

/** Computes the SHA-256 hash (lowercase hex) of a ticket string. */
function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

/**
 * Issues a one-time connection ticket (Requirements 5.15, 5.17, 11.5).
 *
 * Draws {@link TICKET_BYTES} cryptographically-random bytes from the
 * {@link RandomSource} and encodes them as base64url, so the ticket carries at
 * least 128 bits of entropy and is distinct from any ticket issued before with
 * overwhelming probability. It then stores ONLY the SHA-256 hash of the ticket
 * together with its 60 s expiry (Requirement 5.17); the plaintext ticket is
 * returned to the caller and never persisted. `Clock.now()` is read once so the
 * stored expiry and the returned `expiresAt` agree.
 *
 * @returns the plaintext ticket and its expiry (Unix ms).
 */
export async function issueTicket(deps: IssueTicketDeps): Promise<IssuedTicket> {
  const ticket = Buffer.from(deps.random.bytes(TICKET_BYTES)).toString('base64url');
  const expiresAt = deps.clock.now() + TICKET_TTL_MS;
  await deps.realtime.storeTicket(hashTicket(ticket), expiresAt);
  return { ticket, expiresAt };
}

/**
 * Opens a Panel connection for a presented ticket (Requirements 5.7, 5.16,
 * 11.6).
 *
 * Validates the ticket's LENGTH and ALPHABET before hashing: a value whose
 * length is not {@link TICKET_LENGTH} or that contains a character outside the
 * base64url alphabet cannot be a ticket this system issued, so it is rejected
 * without a repository call. A well-formed ticket is hashed and consumed
 * ATOMICALLY: `RealtimeAccessRepository.consumeTicket` deletes the ticket and
 * returns `true` only if it existed and `expiresAt > now`, so at most one
 * connection is ever accepted per ticket even if several requests with the same
 * ticket arrive at once, and a ticket exactly at its boundary (`now ===
 * expiresAt`) is rejected (Requirement 5.16).
 *
 * Only when the ticket is consumed does it store the {@link Connection} (the
 * adapter derives the 24 h TTL). `Clock.now()` is read once and used both to
 * consume the ticket and to stamp the connection's `createdAt`.
 *
 * @param connectionId the API Gateway connection id (transient, non-personal).
 * @returns `true` when the connection was opened, `false` when the ticket was
 *   missing, malformed, expired, or already used.
 */
export async function openConnection(
  deps: OpenConnectionDeps,
  ticket: string,
  connectionId: string,
): Promise<boolean> {
  if (ticket.length !== TICKET_LENGTH || !TICKET_ALPHABET.test(ticket)) {
    return false;
  }

  const now = deps.clock.now();
  const consumed = await deps.realtime.consumeTicket(hashTicket(ticket), now);
  if (!consumed) {
    return false;
  }

  await deps.realtime.addConnection({ connectionId, createdAt: now });
  return true;
}

/**
 * Closes a Panel connection (Requirement 11.7).
 *
 * Removes the stored {@link Connection} on `$disconnect`. It is idempotent: a
 * connection id that is not present is simply a no-op, matching the real
 * adapter's unconditional delete.
 *
 * @param connectionId the API Gateway connection id to remove.
 */
export async function closeConnection(
  realtime: RealtimeAccessRepository,
  connectionId: string,
): Promise<void> {
  await realtime.removeConnection(connectionId);
}
