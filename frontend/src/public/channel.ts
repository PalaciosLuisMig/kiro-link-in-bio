// Source channel of the page load (Requirements 4.1, 4.6, 4.8, 4.9).

import { MAX_CHANNEL_LENGTH } from '@link-in-bio/shared';

/**
 * Reads the channel from the `src` query parameter, and from nothing else, so
 * changing any other parameter never changes the channel (4.6).
 *
 * - Returns `undefined` when `src` is absent (4.1).
 * - Uses only the first occurrence when `src` is repeated (4.8).
 * - `URLSearchParams` never throws on a bad encoding such as `%E0%A4%A`: it
 *   keeps what it cannot decode, so the page loads and the server normalizes
 *   the value (4.9).
 * - Cuts the value to its first 256 UTF-16 code units, the same unit the
 *   `VisitRequest` schema uses. It is NOT normalized here: that is the API's job.
 */
export function readChannel(search: string): string | undefined {
  const value = new URLSearchParams(search).get('src');
  return value === null ? undefined : value.slice(0, MAX_CHANNEL_LENGTH);
}
