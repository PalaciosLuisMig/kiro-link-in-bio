// Node-backed adapters for the Clock, IdGenerator and RandomSource ports.
//
// This module is in the ADAPTERS layer, so it may use Node built-ins
// (`structure.md`). It implements the three "environment" ports with Node APIs:
// `Date.now` for the clock, `node:crypto.randomUUID` (UUID v4) for ids, and
// `node:crypto.randomBytes` for cryptographic randomness. Injecting these ports
// keeps the use cases deterministic in tests (a `FakeClock`, a sequential id
// generator, a fixed byte source) while production uses the real system time
// and CSPRNG.
//
// The Logger adapter is deliberately NOT here: it is the single place allowed to
// touch `console` and lives in its own `logger.ts`, which is the only file the
// ESLint `no-console` rule exempts.

import { randomBytes, randomUUID } from 'node:crypto';

import type { Clock, IdGenerator, RandomSource } from '../domain/ports.js';

/**
 * {@link Clock} backed by the system clock.
 *
 * `now` is `Date.now()` (Unix ms) and `sleep` resolves after at least `ms`
 * milliseconds via a single `setTimeout`. A non-positive `ms` still yields to
 * the event loop, so a caller padding an invocation never busy-waits.
 */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    });
  }
}

/**
 * {@link IdGenerator} producing UUID v4 strings via `node:crypto.randomUUID`.
 */
export class UuidIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

/**
 * {@link RandomSource} producing cryptographically strong bytes via
 * `node:crypto.randomBytes`.
 *
 * Returns a plain {@link Uint8Array} (a Node `Buffer` is one already), matching
 * the port's contract so the domain never sees a Node-specific type.
 */
export class NodeRandomSource implements RandomSource {
  bytes(size: number): Uint8Array {
    return new Uint8Array(randomBytes(size));
  }
}
