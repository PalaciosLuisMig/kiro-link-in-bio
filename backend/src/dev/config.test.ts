import { describe, expect, test } from 'vitest';

import { MIN_TOKEN_LENGTH } from '../lib/domain/authorize-owner.js';

import { ConfigError, readLocalConfig } from './config.js';

// Tests of the configuration of the local development server: the owner token has
// no default, so it can never be written in the source code, and it must be long
// enough for the real API to accept it.

const TOKEN = 't'.repeat(MIN_TOKEN_LENGTH);

describe('readLocalConfig', () => {
  test('reads the token and uses the defaults for the rest', () => {
    expect(readLocalConfig({ LOCAL_OWNER_TOKEN: TOKEN })).toEqual({
      ownerToken: TOKEN,
      port: 8787,
      wsUrl: 'ws://localhost:5173/ws',
    });
  });

  test('the optional settings can be changed', () => {
    expect(
      readLocalConfig({ LOCAL_OWNER_TOKEN: TOKEN, PORT: '9000', LOCAL_WS_URL: 'ws://x:1/ws' }),
    ).toEqual({ ownerToken: TOKEN, port: 9000, wsUrl: 'ws://x:1/ws' });
  });

  test('empty optional settings fall back to the defaults', () => {
    const config = readLocalConfig({ LOCAL_OWNER_TOKEN: TOKEN, PORT: '  ', LOCAL_WS_URL: '' });
    expect(config.port).toBe(8787);
    expect(config.wsUrl).toBe('ws://localhost:5173/ws');
  });

  test('trims the spaces around the token, as the Panel does when it is typed', () => {
    expect(readLocalConfig({ LOCAL_OWNER_TOKEN: `  ${TOKEN}\n` }).ownerToken).toBe(TOKEN);
  });

  test('there is NO default token: a missing one is an error', () => {
    for (const env of [
      {},
      { LOCAL_OWNER_TOKEN: undefined },
      { LOCAL_OWNER_TOKEN: '' },
      { LOCAL_OWNER_TOKEN: '   ' },
    ]) {
      expect(() => readLocalConfig(env)).toThrow(ConfigError);
    }
  });

  test('a missing token says how to fix it: the .env file, and how to make a token', () => {
    let message = '';
    try {
      readLocalConfig({});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('LOCAL_OWNER_TOKEN');
    expect(message).toContain('.env');
    expect(message).toContain('.env.example');
    expect(message).toContain('randomBytes');
  });

  test('a token shorter than the API accepts is refused, and the message gives the numbers', () => {
    const short = 'x'.repeat(MIN_TOKEN_LENGTH - 1);
    expect(() => readLocalConfig({ LOCAL_OWNER_TOKEN: short })).toThrow(
      `${short.length} caracteres y necesita al menos ${MIN_TOKEN_LENGTH}`,
    );
  });

  test('exactly the minimum length is accepted', () => {
    expect(() =>
      readLocalConfig({ LOCAL_OWNER_TOKEN: 'x'.repeat(MIN_TOKEN_LENGTH) }),
    ).not.toThrow();
  });

  test('the error never repeats the token that was given', () => {
    const short = 'secreto-corto';
    let message = '';
    try {
      readLocalConfig({ LOCAL_OWNER_TOKEN: short });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(short);
  });

  test('the minimum is the same one the real API enforces', () => {
    expect(MIN_TOKEN_LENGTH).toBe(32);
  });

  test.each(['abc', '-1', '70000', '8787.5'])('an invalid port (%s) is refused', (port) => {
    expect(() => readLocalConfig({ LOCAL_OWNER_TOKEN: TOKEN, PORT: port })).toThrow(ConfigError);
  });

  test('port 0 (any free port) is allowed', () => {
    expect(readLocalConfig({ LOCAL_OWNER_TOKEN: TOKEN, PORT: '0' }).port).toBe(0);
  });
});
