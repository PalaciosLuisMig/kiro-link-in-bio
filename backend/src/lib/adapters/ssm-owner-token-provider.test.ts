import { GetParameterCommand } from '@aws-sdk/client-ssm';
import type { GetParameterCommandOutput } from '@aws-sdk/client-ssm';
import { beforeEach, describe, expect, test } from 'vitest';

import { FakeClock } from '../domain/testing/fakes.js';

import type { SsmSend } from './ssm-owner-token-provider.js';
import {
  DEFAULT_OWNER_TOKEN_TTL_MS,
  OWNER_TOKEN_PARAMETER_NAME,
  SsmOwnerTokenProvider,
  resetOwnerTokenCacheForTests,
} from './ssm-owner-token-provider.js';

// Tests for the SSM owner-token adapter (task 9.4), driven by a FAKE SSM client.
// They assert the module-level cache behaviour (a hit within the TTL does not
// call SSM; a call after the TTL refetches), that decryption is requested, and
// that a missing parameter value is surfaced as an empty string (so the domain
// can return 500 for a misconfigured server).

/**
 * A fake {@link SsmSend} that records every `GetParameterCommand` input and
 * returns a scripted value. Lets a test count the calls and assert the request.
 */
class FakeSsmClient implements SsmSend {
  readonly inputs: Array<GetParameterCommand['input']> = [];
  value: string | undefined;

  constructor(value: string | undefined) {
    this.value = value;
  }

  async send(command: GetParameterCommand): Promise<GetParameterCommandOutput> {
    this.inputs.push(command.input);
    return {
      Parameter: this.value === undefined ? undefined : { Value: this.value },
      $metadata: {},
    } as GetParameterCommandOutput;
  }
}

beforeEach(() => {
  // The cache is module scope; reset it so each test starts cold.
  resetOwnerTokenCacheForTests();
});

describe('SsmOwnerTokenProvider', () => {
  test('reads the parameter with decryption on a cache miss', async () => {
    const client = new FakeSsmClient('a'.repeat(40));
    const provider = new SsmOwnerTokenProvider(client, new FakeClock(0));

    const token = await provider.getToken();

    expect(token).toBe('a'.repeat(40));
    expect(client.inputs).toHaveLength(1);
    expect(client.inputs[0]).toEqual({
      Name: OWNER_TOKEN_PARAMETER_NAME,
      WithDecryption: true,
    });
  });

  test('a second call within the TTL is served from cache without hitting SSM', async () => {
    const client = new FakeSsmClient('secret-token-value-32-chars-long!!');
    const clock = new FakeClock(0);
    const provider = new SsmOwnerTokenProvider(client, clock);

    await provider.getToken();
    // Move almost to the edge of the TTL, still fresh.
    clock.set(DEFAULT_OWNER_TOKEN_TTL_MS - 1);
    const second = await provider.getToken();

    expect(second).toBe('secret-token-value-32-chars-long!!');
    expect(client.inputs).toHaveLength(1);
  });

  test('refetches after the TTL has elapsed', async () => {
    const client = new FakeSsmClient('first-token-value-32-chars-long!!');
    const clock = new FakeClock(0);
    const provider = new SsmOwnerTokenProvider(client, clock);

    await provider.getToken();
    // Rotate the token in SSM and move past the TTL.
    client.value = 'second-token-value-32-chars-long!';
    clock.set(DEFAULT_OWNER_TOKEN_TTL_MS);
    const refreshed = await provider.getToken();

    expect(refreshed).toBe('second-token-value-32-chars-long!');
    expect(client.inputs).toHaveLength(2);
  });

  test('the cache is shared across provider instances (warm-container reuse)', async () => {
    const client = new FakeSsmClient('shared-token-value-32-chars-long!');
    const clock = new FakeClock(0);

    await new SsmOwnerTokenProvider(client, clock).getToken();
    // A fresh provider (new invocation) reuses the module-level cache.
    const second = await new SsmOwnerTokenProvider(client, clock).getToken();

    expect(second).toBe('shared-token-value-32-chars-long!');
    expect(client.inputs).toHaveLength(1);
  });

  test('a custom TTL controls when the value is refetched', async () => {
    const client = new FakeSsmClient('ttl-token-value-32-characters!!!!');
    const clock = new FakeClock(0);
    const provider = new SsmOwnerTokenProvider(client, clock, 1000);

    await provider.getToken();
    clock.set(999);
    await provider.getToken();
    expect(client.inputs).toHaveLength(1);

    clock.set(1000);
    await provider.getToken();
    expect(client.inputs).toHaveLength(2);
  });

  test('a missing parameter value is surfaced as an empty string', async () => {
    const client = new FakeSsmClient(undefined);
    const provider = new SsmOwnerTokenProvider(client, new FakeClock(0));

    await expect(provider.getToken()).resolves.toBe('');
  });
});
