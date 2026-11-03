import { afterEach, describe, expect, test, vi } from 'vitest';

import { ConsoleLogger } from './logger.js';

// Tests for the Logger adapter (task 9.4). They assert that only the allowed
// fields (`code`, `route`, `requestId`) ever reach `console`, that `info` and
// `error` route to the right stream, and — crucially for privacy (Requirements
// 5.18, 11.2) — that a forbidden field present at runtime is NEVER serialized,
// backing the port's compile-time guarantee with a runtime one.

afterEach(() => {
  vi.restoreAllMocks();
});

/** Captures `console.log` output as the parsed JSON line. */
function captureLog(run: (logger: ConsoleLogger) => void): Record<string, unknown> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  run(new ConsoleLogger());
  expect(spy).toHaveBeenCalledTimes(1);
  return JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
}

describe('ConsoleLogger', () => {
  test('info writes one JSON line with level, message and allowed fields', () => {
    const line = captureLog((logger) =>
      logger.info('click_recorded', {
        code: 'ok',
        route: '/api/clicks',
        requestId: 'req-1',
      }),
    );

    expect(line).toEqual({
      level: 'info',
      message: 'click_recorded',
      code: 'ok',
      route: '/api/clicks',
      requestId: 'req-1',
    });
  });

  test('omits context fields that were not provided', () => {
    const line = captureLog((logger) => logger.info('started', { route: '/api/links' }));

    expect(line).toEqual({ level: 'info', message: 'started', route: '/api/links' });
    expect(line).not.toHaveProperty('code');
    expect(line).not.toHaveProperty('requestId');
  });

  test('info with no context logs only level and message', () => {
    const line = captureLog((logger) => logger.info('warm'));

    expect(line).toEqual({ level: 'info', message: 'warm' });
  });

  test('error routes to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    new ConsoleLogger().error('boom', { code: 'server_error' });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(line).toEqual({ level: 'error', message: 'boom', code: 'server_error' });
  });

  test('a forbidden field present at runtime is never serialized', () => {
    // The port's type blocks this at compile time; here we force an untyped
    // value past the type system to prove the RUNTIME guard drops it too.
    const sneaky = {
      code: 'auth',
      token: 'super-secret-owner-token',
      body: '{"linkId":"x"}',
      authorization: 'Bearer leaked',
    } as unknown as { code?: string };

    const line = captureLog((logger) => logger.info('authorized', sneaky));

    expect(line).toEqual({ level: 'info', message: 'authorized', code: 'auth' });
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain('super-secret-owner-token');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('body');
    expect(serialized).not.toContain('authorization');
  });
});
