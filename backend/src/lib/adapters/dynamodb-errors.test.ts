import { describe, expect, test } from 'vitest';

import { ERROR_REASONS } from '@link-in-bio/shared';

import { NotFound, ValidationError } from '../domain/errors.js';
import {
  isConditionalCheckFailed,
  mapReorderError,
  mapUpdateLinkError,
} from './dynamodb-errors.js';

// Tests for the pure error-mapping helpers (task 9.2). They exercise the three
// outcomes the real adapters (task 9.3) rely on, using FAKE errors that carry
// only the `name` the AWS SDK v3 would set, since that is what the helpers match
// on. They also pin the contract that an unrelated error is passed through
// unchanged and never swallowed.

/** An AWS-SDK-shaped error: the helpers identify it by its `name`. */
function sdkError(name: string): Error {
  const error = new Error(`fake ${name}`);
  error.name = name;
  return error;
}

const conditionalCheckFailed = sdkError('ConditionalCheckFailedException');
const transactionCancelled = sdkError('TransactionCanceledException');
const unrelated = sdkError('ProvisionedThroughputExceededException');

describe('isConditionalCheckFailed (ticket path: "not consumed")', () => {
  test('is true for a ConditionalCheckFailedException', () => {
    expect(isConditionalCheckFailed(conditionalCheckFailed)).toBe(true);
  });

  test('is false for any other error, so it is not treated as "not consumed"', () => {
    expect(isConditionalCheckFailed(transactionCancelled)).toBe(false);
    expect(isConditionalCheckFailed(unrelated)).toBe(false);
  });

  test('is false for non-error values', () => {
    expect(isConditionalCheckFailed(undefined)).toBe(false);
    expect(isConditionalCheckFailed(null)).toBe(false);
    expect(isConditionalCheckFailed('ConditionalCheckFailedException')).toBe(false);
    expect(isConditionalCheckFailed({})).toBe(false);
  });

  // The adapter's consumeTicket uses this boolean to RETURN false (not throw).
  // This simulates that usage against a fake `send` that rejects.
  test('drives a consumeTicket-style outcome: false on failure, true on success', async () => {
    async function consumeTicket(send: () => Promise<unknown>): Promise<boolean> {
      try {
        await send();
        return true;
      } catch (error) {
        if (isConditionalCheckFailed(error)) {
          return false;
        }
        throw error;
      }
    }

    await expect(consumeTicket(() => Promise.resolve({}))).resolves.toBe(true);
    await expect(consumeTicket(() => Promise.reject(conditionalCheckFailed))).resolves.toBe(false);
    // An unrelated failure is NOT swallowed into `false`; it propagates.
    await expect(consumeTicket(() => Promise.reject(unrelated))).rejects.toBe(unrelated);
  });
});

describe('mapUpdateLinkError (link edit path)', () => {
  test('throws NotFound on a ConditionalCheckFailedException', () => {
    expect(() => mapUpdateLinkError(conditionalCheckFailed)).toThrow(NotFound);
  });

  test('rethrows an unrelated error unchanged', () => {
    expect(() => mapUpdateLinkError(unrelated)).toThrow(unrelated);
  });

  test('does not map a TransactionCanceledException to NotFound', () => {
    expect(() => mapUpdateLinkError(transactionCancelled)).toThrow(transactionCancelled);
  });
});

describe('mapReorderError (reorder path)', () => {
  test('throws ValidationError naming `ids` on a TransactionCanceledException', () => {
    expect(() => mapReorderError(transactionCancelled)).toThrow(ValidationError);
    try {
      mapReorderError(transactionCancelled);
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields).toEqual(['ids']);
      expect((error as ValidationError).reason).toBe(ERROR_REASONS.idsNotPermutation);
    }
  });

  test('rethrows an unrelated error unchanged', () => {
    expect(() => mapReorderError(unrelated)).toThrow(unrelated);
  });

  test('does not map a ConditionalCheckFailedException to ValidationError', () => {
    expect(() => mapReorderError(conditionalCheckFailed)).toThrow(conditionalCheckFailed);
  });
});
