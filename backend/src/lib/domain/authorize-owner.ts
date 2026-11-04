// Pure domain use case: owner authorization for admin requests.
//
// This module is domain logic. It takes its port (`OwnerTokenProvider`) as an
// injected dependency and never imports the AWS SDK, a Lambda handler, or an
// adapter; the composition roots wire the real SSM-backed provider and the
// tests wire the in-memory double (`testing/fakes.ts`). It does use
// `node:crypto` for a SHA-256 constant-time comparison, which the domain ESLint
// boundary allows (only the AWS SDK, handlers and adapters are forbidden here):
// the hashing is an intrinsic part of the comparison rule, not an outbound side
// effect, so it stays in the domain rather than behind a port, exactly like the
// sibling `realtime-access.ts`.
//
// Error precedence (Requirements 5.2, 5.3, 5.4, 5.5): a server configured with
// an owner token shorter than 32 characters is misconfigured, and EVERY admin
// request must then fail with 500 (`ServerMisconfigured`), ahead of the 401
// (`Unauthorized`) for a wrong, missing, or empty presented token. So an
// attacker cannot distinguish "wrong token" from "server misconfigured". The
// short-token check therefore runs first and wins unconditionally; only a
// correctly configured server ever reaches the comparison of the presented
// token.

import { createHash, timingSafeEqual } from 'node:crypto';

import { ServerMisconfigured, Unauthorized } from './errors.js';
import type { OwnerTokenProvider } from './ports.js';

/**
 * Minimum length (characters) of a correctly configured owner token. A shorter
 * configured token means the server is misconfigured (Requirement 5.5).
 */
export const MIN_TOKEN_LENGTH = 32;

/**
 * Computes the SHA-256 digest of a token as a fixed-length buffer.
 *
 * Hashing both sides to equal-length (32-byte) buffers lets
 * {@link timingSafeEqual} run without ever throwing on a length mismatch, so a
 * missing, empty, or differently-sized presented token is simply unequal rather
 * than an exception, and the comparison stays constant-time.
 */
function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Authorizes an admin request against the configured owner token (Requirements
 * 5.2, 5.3, 5.4, 5.5).
 *
 * First reads the configured token from the {@link OwnerTokenProvider}. If it
 * is shorter than {@link MIN_TOKEN_LENGTH} characters, throws
 * {@link ServerMisconfigured} (HTTP 500). This check WINS over everything else:
 * with a short server token the request fails with 500 even when the presented
 * token is also wrong, missing, or empty, so the outcome is indistinguishable
 * from any other misconfigured-server request (Requirement 5.5).
 *
 * Otherwise it compares the presented token against the configured one in
 * CONSTANT TIME, via SHA-256 digests and {@link timingSafeEqual}, so the time
 * taken does not leak how many leading characters matched (Requirement 5.4).
 * On a mismatch it throws {@link Unauthorized} (HTTP 401, Requirement 5.3); a
 * missing or empty presented token hashes to a value that cannot equal the
 * configured token's and is therefore rejected the same way. On a match it
 * returns normally (Requirement 5.2).
 *
 * @param provider supplies the configured owner token.
 * @param presentedToken the token carried by the admin request.
 * @throws {ServerMisconfigured} when the configured token is too short.
 * @throws {Unauthorized} when the presented token does not match.
 */
export async function authorizeOwner(
  provider: OwnerTokenProvider,
  presentedToken: string,
): Promise<void> {
  const configuredToken = await provider.getToken();

  if (configuredToken.length < MIN_TOKEN_LENGTH) {
    throw new ServerMisconfigured();
  }

  if (!timingSafeEqual(digest(presentedToken), digest(configuredToken))) {
    throw new Unauthorized();
  }
}
