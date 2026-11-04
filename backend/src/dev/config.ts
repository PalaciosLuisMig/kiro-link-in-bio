// Configuration of the LOCAL development server (not deployed), read from the
// environment. `npm run dev:api` loads the `.env` file of the project root into the
// environment, so the owner token lives there and not in the source code.

import { MIN_TOKEN_LENGTH } from '../lib/domain/authorize-owner.js';

export interface LocalConfig {
  readonly port: number;
  /** The token the Panel signs in with. */
  readonly ownerToken: string;
  /** The WebSocket URL the Panel is told to use (through the Vite proxy). */
  readonly wsUrl: string;
}

/** The configuration is missing or wrong. The message says how to fix it. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_PORT = 8787;
const DEFAULT_WS_URL = 'ws://localhost:5173/ws';

const HOW_TO_CREATE_THE_FILE = [
  'Crea el archivo .env en la raíz del proyecto (no se sube a git):',
  '',
  '  copia .env.example como .env',
  '',
  'y escribe en él LOCAL_OWNER_TOKEN con el token que quieras usar para entrar al Panel.',
  'Para generar uno:',
  '',
  `  node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"`,
].join('\n');

/**
 * Reads and checks the configuration.
 *
 * The token is REQUIRED: there is no default, so no token is ever written in the
 * source code. It must have at least {@link MIN_TOKEN_LENGTH} characters, the same
 * minimum the real API enforces: a shorter one would make every admin request fail
 * with a 500 that says nothing about why.
 *
 * @throws {ConfigError} with a message that explains what to do.
 */
export function readLocalConfig(env: Readonly<Record<string, string | undefined>>): LocalConfig {
  const token = env.LOCAL_OWNER_TOKEN?.trim() ?? '';

  if (token === '') {
    throw new ConfigError(`Falta LOCAL_OWNER_TOKEN.\n\n${HOW_TO_CREATE_THE_FILE}`);
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `LOCAL_OWNER_TOKEN tiene ${token.length} caracteres y necesita al menos ${MIN_TOKEN_LENGTH}.\n\n${HOW_TO_CREATE_THE_FILE}`,
    );
  }

  const rawPort = env.PORT?.trim();
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError(`PORT debe ser un número de puerto válido (0-65535), y es "${rawPort}".`);
  }

  const wsUrl = env.LOCAL_WS_URL?.trim() || DEFAULT_WS_URL;
  return { port, ownerToken: token, wsUrl };
}
