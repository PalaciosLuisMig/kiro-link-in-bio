// Session of the Panel (task 15.6): the owner token, kept only for the tab.
//
// Requirements 5.1, 5.10 and 5.11. The token goes in `sessionStorage` and nowhere
// else: not in a cookie, not in `localStorage`, not in any URL. Reloading the tab
// keeps the session; closing the tab or pressing "Cerrar sesión" ends it.

import { UnauthorizedError } from './api.js';

/** Key of the saved token in `sessionStorage`. */
export const TOKEN_STORAGE_KEY = 'link-in-bio.owner-token';

/** The part of `Storage` the session uses (so a test can fake it). */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Removes the spaces and line breaks at both ends of what the owner typed (5.1). */
export function cleanToken(raw: string): string {
  return raw.trim();
}

export type TokenInput = { readonly ok: true; readonly token: string } | { readonly ok: false };

/** Validates the login form: an empty or all-whitespace token is rejected (5.12). */
export function readTokenInput(raw: string): TokenInput {
  const token = cleanToken(raw);
  return token === '' ? { ok: false } : { ok: true, token };
}

export interface Session {
  /** The saved token, or `null` when there is no session. */
  token(): string | null;
  /** Saves an already cleaned token in memory and in `sessionStorage`. */
  save(token: string): void;
  /** Forgets the token from memory and from `sessionStorage` (5.8, 5.11). */
  clear(): void;
}

/**
 * Creates the session. It reads the saved token once, so a reloaded tab keeps it.
 *
 * `sessionStorage` can be missing or throw (a private window, blocked site data):
 * the session then lives in memory only, and the Panel still works until reload.
 *
 * @param storage `window.sessionStorage`, or `null` when it is not available.
 */
export function createSession(storage: TokenStorage | null): Session {
  let current: string | null = null;
  try {
    current = storage?.getItem(TOKEN_STORAGE_KEY) ?? null;
  } catch {
    current = null;
  }

  return {
    token: () => current,
    save(token) {
      current = token;
      try {
        storage?.setItem(TOKEN_STORAGE_KEY, token);
      } catch {
        // Memory only: see above.
      }
    },
    clear() {
      current = null;
      try {
        storage?.removeItem(TOKEN_STORAGE_KEY);
      } catch {
        // Nothing left to clear.
      }
    },
  };
}

// --- Signing in ---------------------------------------------------------------

/**
 * What a sign-in attempt came to:
 * - `ok`: the token was accepted;
 * - `empty`: nothing usable was typed, and no request was sent (5.12);
 * - `unauthorized`: the API refused it, and it was forgotten (5.8);
 * - `unreachable`: the API did not answer in time or failed, which is NOT the
 *   same as a wrong token (5.13).
 */
export type SignInResult = 'ok' | 'empty' | 'unauthorized' | 'unreachable';

export interface SignInDeps {
  readonly session: Session;
  /** Any admin call that needs a valid token: it throws `UnauthorizedError` on a 401. */
  readonly validate: () => Promise<unknown>;
}

async function validateSaved(deps: SignInDeps): Promise<'ok' | 'unauthorized' | 'unreachable'> {
  try {
    await deps.validate();
    return 'ok';
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      deps.session.clear();
      return 'unauthorized';
    }
    // The token stays saved: the server may only be down for a moment.
    return 'unreachable';
  }
}

/**
 * Handles the login form (5.1, 5.8, 5.12, 5.13): cleans what was typed, refuses an
 * empty value without a request, saves the token and checks it with the API.
 */
export async function signIn(deps: SignInDeps, rawInput: string): Promise<SignInResult> {
  const input = readTokenInput(rawInput);
  if (!input.ok) {
    return 'empty';
  }
  deps.session.save(input.token);
  return validateSaved(deps);
}

/**
 * What a reloaded tab does (5.10): with a saved token it checks it again, and
 * with none there is nothing to do.
 */
export async function resumeSession(deps: SignInDeps): Promise<SignInResult | 'none'> {
  if (deps.session.token() === null) {
    return 'none';
  }
  return validateSaved(deps);
}
