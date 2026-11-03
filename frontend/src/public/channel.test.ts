import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { MAX_CHANNEL_LENGTH, VisitRequest } from '@link-in-bio/shared';

import { readChannel } from './channel.js';

// Tests of the channel reading (task 14.3): only `src` counts, only its first
// occurrence, a bad encoding does not break anything, and the value is cut to
// 256 UTF-16 code units and is never normalized here.
//
// Validates: Requirements 4.1, 4.6, 4.8, 4.9.

const numRuns = Number(import.meta.env.FC_NUM_RUNS ?? '100');

describe('readChannel', () => {
  test('returns undefined when `src` is absent', () => {
    expect(readChannel('')).toBeUndefined();
    expect(readChannel('?')).toBeUndefined();
    expect(readChannel('?utm_source=qr&ref=x')).toBeUndefined();
  });

  test('returns the value of `src`, without normalizing it', () => {
    expect(readChannel('?src=qr')).toBe('qr');
    expect(readChannel('?src=Instagram')).toBe('Instagram');
    expect(readChannel('?src=canal+inventado')).toBe('canal inventado');
    expect(readChannel('?src=%C3%A9')).toBe('é');
  });

  test('an empty `src` is sent as an empty value (the API maps it to `directo`)', () => {
    expect(readChannel('?src=')).toBe('');
    expect(readChannel('?src')).toBe('');
  });

  test('uses only the first occurrence of a repeated `src`', () => {
    expect(readChannel('?src=qr&src=tiktok')).toBe('qr');
    expect(readChannel('?src=&src=tiktok')).toBe('');
  });

  test('a bad URL encoding does not throw and keeps what cannot be decoded', () => {
    expect(() => readChannel('?src=%E0%A4%A')).not.toThrow();
    expect(typeof readChannel('?src=%E0%A4%A')).toBe('string');
    expect(readChannel('?src=%')).toBe('%');
    expect(readChannel('?src=%zz')).toBe('%zz');
  });

  test('other parameters never change the channel', () => {
    const base = readChannel('?src=github');
    expect(readChannel('?utm=1&src=github&x=2')).toBe(base);
    expect(readChannel('?SRC=other&src=github')).toBe(base);
    expect(readChannel('?source=other&src=github')).toBe(base);
  });

  test('cuts the value to 256 UTF-16 code units', () => {
    const long = 'a'.repeat(MAX_CHANNEL_LENGTH + 100);
    expect(readChannel(`?src=${long}`)).toBe('a'.repeat(MAX_CHANNEL_LENGTH));
    expect(readChannel(`?src=${'a'.repeat(MAX_CHANNEL_LENGTH)}`)).toHaveLength(MAX_CHANNEL_LENGTH);
  });

  test('anything it returns satisfies the VisitRequest contract', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (raw) => {
        const channel = readChannel(`?src=${encodeURIComponent(raw)}`);
        expect(VisitRequest.safeParse({ channel }).success).toBe(true);
      }),
      { numRuns },
    );
    // Raw, undecodable input too: the page must never produce an invalid value.
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (search) => {
        const channel = readChannel(search);
        expect(VisitRequest.safeParse({ channel }).success).toBe(true);
      }),
      { numRuns },
    );
  });
});
