// SSM Parameter Store adapter for the OwnerTokenProvider port.
//
// This module is in the ADAPTERS layer, so it may depend on the AWS SDK
// (`structure.md`). It implements `OwnerTokenProvider.getToken()` by reading the
// SecureString parameter `/link-in-bio/owner-token` WITH decryption, and caches
// the value at MODULE scope so it survives across Lambda invocations in a warm
// container. The cache carries an expiry: once older than its TTL (default
// 5 min) the next `getToken` refetches from SSM, so rotating the token in SSM
// takes up to the TTL to take effect (design 5.3). It holds no business logic:
// `authorizeOwner` (the domain) decides what a value shorter than 32 chars means
// (Requirement 5.5); this adapter only supplies the configured value.
//
// The SSM client is INJECTED (constructor param), not created here, so the
// composition roots (tasks 10.4 / 11.x) own client construction and the unit
// tests drive the adapter with a fake client and a fake clock — no AWS needed.

import type { GetParameterCommandOutput } from '@aws-sdk/client-ssm';
import { GetParameterCommand } from '@aws-sdk/client-ssm';

import type { Clock, OwnerTokenProvider } from '../domain/ports.js';

/** The SSM parameter name holding the owner token as a SecureString. */
export const OWNER_TOKEN_PARAMETER_NAME = '/link-in-bio/owner-token';

/** Default cache TTL: 5 minutes in milliseconds (design 5.3). */
export const DEFAULT_OWNER_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * The subset of the SSM client this adapter uses: a single `send` of a
 * `GetParameterCommand`. Narrowing it keeps the adapter decoupled from the full
 * client surface and makes a fake trivial to write in tests.
 */
export interface SsmSend {
  send(command: GetParameterCommand): Promise<GetParameterCommandOutput>;
}

/** A cached token together with the Unix-ms time at which it stops being fresh. */
interface CacheEntry {
  readonly value: string;
  readonly expiresAt: number;
}

/**
 * Module-level cache, shared by every {@link SsmOwnerTokenProvider} in the warm
 * container. It is intentionally module scope (not instance state) so it
 * survives across Lambda invocations: a cold start creates a fresh provider but
 * the first `getToken` within the TTL after any prior invocation reuses this
 * value instead of calling SSM again.
 */
let cache: CacheEntry | undefined;

/**
 * Clears the module-level token cache. Exposed ONLY for unit tests so each test
 * starts from a known cold state; production code never calls it.
 */
export function resetOwnerTokenCacheForTests(): void {
  cache = undefined;
}

/**
 * {@link OwnerTokenProvider} backed by SSM Parameter Store.
 *
 * On a cache miss or after the cached value's TTL has elapsed, it reads
 * `/link-in-bio/owner-token` with decryption and stores the value with a new
 * expiry of `now + ttlMs`. Within the TTL, repeated `getToken` calls return the
 * cached value without touching SSM.
 */
export class SsmOwnerTokenProvider implements OwnerTokenProvider {
  constructor(
    private readonly client: SsmSend,
    private readonly clock: Clock,
    private readonly ttlMs: number = DEFAULT_OWNER_TOKEN_TTL_MS,
    private readonly parameterName: string = OWNER_TOKEN_PARAMETER_NAME,
  ) {}

  async getToken(): Promise<string> {
    const now = this.clock.now();
    if (cache !== undefined && now < cache.expiresAt) {
      return cache.value;
    }
    const value = await this.fetch();
    cache = { value, expiresAt: now + this.ttlMs };
    return value;
  }

  /** Reads the SecureString parameter with decryption. */
  private async fetch(): Promise<string> {
    const output = await this.client.send(
      new GetParameterCommand({ Name: this.parameterName, WithDecryption: true }),
    );
    // A missing `Value` is treated as an empty string: the domain's
    // `authorizeOwner` then sees a too-short token and returns 500 (5.5),
    // which is the correct behaviour for a misconfigured server.
    return output.Parameter?.Value ?? '';
  }
}
