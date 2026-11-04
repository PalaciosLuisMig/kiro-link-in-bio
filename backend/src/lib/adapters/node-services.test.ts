import { describe, expect, test } from 'vitest';

import { NodeRandomSource, SystemClock, UuidIdGenerator } from './node-services.js';

// Tests for the Node-backed environment adapters (task 9.4): that the clock is
// real time, `sleep` actually waits, the id generator yields distinct UUID v4
// strings, and the random source returns the requested number of bytes.

/** Matches a canonical lowercase UUID v4 string. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('SystemClock', () => {
  test('now returns a plausible Unix-ms time', () => {
    const before = Date.now();
    const value = new SystemClock().now();
    const after = Date.now();

    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  test('sleep waits for at least the requested time', async () => {
    const clock = new SystemClock();
    const start = Date.now();
    await clock.sleep(20);

    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  test('sleep tolerates a non-positive duration', async () => {
    await expect(new SystemClock().sleep(-5)).resolves.toBeUndefined();
  });
});

describe('UuidIdGenerator', () => {
  test('produces UUID v4 strings', () => {
    expect(new UuidIdGenerator().next()).toMatch(UUID_V4);
  });

  test('produces distinct values on consecutive calls', () => {
    const generator = new UuidIdGenerator();
    const values = new Set([generator.next(), generator.next(), generator.next()]);

    expect(values.size).toBe(3);
  });
});

describe('NodeRandomSource', () => {
  test('returns the requested number of bytes as a Uint8Array', () => {
    const bytes = new NodeRandomSource().bytes(32);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(32);
  });

  test('is unlikely to repeat across draws', () => {
    const source = new NodeRandomSource();
    const a = Buffer.from(source.bytes(32)).toString('hex');
    const b = Buffer.from(source.bytes(32)).toString('hex');

    expect(a).not.toBe(b);
  });
});
