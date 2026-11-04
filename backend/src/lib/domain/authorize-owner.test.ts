import { describe, expect, test } from 'vitest';

import { authorizeOwner } from './authorize-owner.js';
import { ServerMisconfigured, Unauthorized } from './errors.js';
import { InMemoryOwnerTokenProvider } from './testing/fakes.js';

// Unit tests for the owner-authorization use case (task 7.1): `authorizeOwner`.
//
// These pin the concrete behaviour and, crucially, the error precedence: a
// configured owner token shorter than 32 chars makes every admin request fail
// with `ServerMisconfigured` (500), ahead of the `Unauthorized` (401) for a
// wrong/missing/empty presented token, so an attacker cannot tell "wrong token"
// from "server misconfigured". A correctly configured server compares the
// presented token in constant time and either resolves (match) or rejects with
// `Unauthorized` (mismatch).
//
// Validates: Requirements 5.2, 5.3, 5.4, 5.5.

/** A valid configured token: exactly 32 characters (the minimum length). */
const VALID_TOKEN = 'a'.repeat(32);

describe('authorizeOwner', () => {
  // The presented token equals the configured token, so authorization passes.
  // Validates: Requirement 5.2
  test('resolves for a matching token', async () => {
    const provider = new InMemoryOwnerTokenProvider(VALID_TOKEN);

    await expect(authorizeOwner(provider, VALID_TOKEN)).resolves.toBeUndefined();
  });

  // A configured token of exactly 32 characters is the boundary of a valid
  // configuration: it is not misconfigured, and a matching presented token
  // still resolves.
  // Validates: Requirements 5.2, 5.5
  test('resolves at the 32-char configured-token boundary with a matching token', async () => {
    const token = 'x'.repeat(32);
    expect(token).toHaveLength(32);
    const provider = new InMemoryOwnerTokenProvider(token);

    await expect(authorizeOwner(provider, token)).resolves.toBeUndefined();
  });

  // A presented token that differs from the configured one is rejected with
  // `Unauthorized` (401).
  // Validates: Requirement 5.3
  test('rejects a wrong token with Unauthorized', async () => {
    const provider = new InMemoryOwnerTokenProvider(VALID_TOKEN);

    await expect(authorizeOwner(provider, 'b'.repeat(32))).rejects.toBeInstanceOf(Unauthorized);
  });

  // An empty presented token is simply unequal to the configured token and is
  // rejected with `Unauthorized`; hashing both sides means the length mismatch
  // never throws.
  // Validates: Requirement 5.3
  test('rejects an empty presented token with Unauthorized', async () => {
    const provider = new InMemoryOwnerTokenProvider(VALID_TOKEN);

    await expect(authorizeOwner(provider, '')).rejects.toBeInstanceOf(Unauthorized);
  });

  // A presented token of a different length than the configured one is rejected
  // with `Unauthorized`, confirming the equal-length-digest comparison does not
  // throw on a length mismatch.
  // Validates: Requirement 5.3
  test('rejects a differently-sized presented token with Unauthorized', async () => {
    const provider = new InMemoryOwnerTokenProvider(VALID_TOKEN);

    await expect(authorizeOwner(provider, `${VALID_TOKEN}extra`)).rejects.toBeInstanceOf(
      Unauthorized,
    );
  });

  // A configured token shorter than 32 chars means the server is misconfigured:
  // the request fails with `ServerMisconfigured` (500).
  // Validates: Requirement 5.5
  test('rejects with ServerMisconfigured when the configured token is too short', async () => {
    const provider = new InMemoryOwnerTokenProvider('short-token');

    await expect(authorizeOwner(provider, 'short-token')).rejects.toBeInstanceOf(
      ServerMisconfigured,
    );
  });

  // Precedence: a short configured token wins over a wrong presented token. The
  // outcome is `ServerMisconfigured` (500), NOT `Unauthorized` (401), so the
  // response is indistinguishable from any other misconfigured-server request.
  // Validates: Requirement 5.5
  test('ServerMisconfigured wins over a wrong presented token', async () => {
    const provider = new InMemoryOwnerTokenProvider('too-short');

    await expect(authorizeOwner(provider, 'definitely-wrong-token')).rejects.toBeInstanceOf(
      ServerMisconfigured,
    );
  });

  // Precedence also holds when the presented token is empty: still 500, not 401.
  // Validates: Requirement 5.5
  test('ServerMisconfigured wins over an empty presented token', async () => {
    const provider = new InMemoryOwnerTokenProvider('too-short');

    await expect(authorizeOwner(provider, '')).rejects.toBeInstanceOf(ServerMisconfigured);
  });

  // The boundary just below the minimum (31 chars) is still misconfigured.
  // Validates: Requirement 5.5
  test('treats a 31-char configured token as misconfigured', async () => {
    const token = 'y'.repeat(31);
    expect(token).toHaveLength(31);
    const provider = new InMemoryOwnerTokenProvider(token);

    await expect(authorizeOwner(provider, token)).rejects.toBeInstanceOf(ServerMisconfigured);
  });
});
