// Source channel contracts, shared between frontend and backend.
// Pure TypeScript only: no Node, DOM, or AWS imports.

/**
 * Fixed list of predefined source channels. Any value that, after lowercasing
 * only its A-Z letters, matches one of these is kept as-is by `normalizeChannel`.
 */
export const PREDEFINED_CHANNELS = [
  'qr',
  'instagram',
  'tiktok',
  'x',
  'facebook',
  'linkedin',
  'youtube',
  'whatsapp',
  'telegram',
  'github',
] as const;

/** A channel from the fixed predefined list. */
export type PredefinedChannel = (typeof PREDEFINED_CHANNELS)[number];

/** The special channel used when no source value is provided. */
export const DIRECT_CHANNEL = 'directo';

/** The catch-all channel used for any value that is not predefined nor direct. */
export const OTHER_CHANNEL = 'otro';

/** Every channel `normalizeChannel` can return. */
export type NormalizedChannel = PredefinedChannel | typeof DIRECT_CHANNEL | typeof OTHER_CHANNEL;

const PREDEFINED_CHANNEL_SET: ReadonlySet<string> = new Set(PREDEFINED_CHANNELS);

/**
 * Lowercases only the A-Z letters of a string.
 *
 * We deliberately avoid `String.prototype.toLowerCase()` because it maps a few
 * non-ASCII code points onto ASCII letters (for example the Kelvin sign U+212A
 * becomes `k`), which would let unexpected inputs collapse onto a predefined
 * channel. Restricting the transform to the A-Z range keeps the mapping exact.
 */
function lowercaseAsciiLetters(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/**
 * Normalizes a raw source-channel value to one of the allowed channels.
 *
 * - An absent (undefined/null) or empty value becomes `directo`.
 * - Otherwise only A-Z letters are lowercased (never `toLowerCase()`).
 * - The normalized value is returned when it is a predefined channel, `directo`
 *   or `otro`; any other value becomes `otro`.
 *
 * Idempotent: `normalizeChannel(normalizeChannel(v))` equals `normalizeChannel(v)`.
 */
export function normalizeChannel(value: string | undefined | null): NormalizedChannel {
  if (value === undefined || value === null || value === '') {
    return DIRECT_CHANNEL;
  }

  const normalized = lowercaseAsciiLetters(value);

  if (
    PREDEFINED_CHANNEL_SET.has(normalized) ||
    normalized === DIRECT_CHANNEL ||
    normalized === OTHER_CHANNEL
  ) {
    return normalized as NormalizedChannel;
  }

  return OTHER_CHANNEL;
}

/** A channel entry ordered by `compareChannels`: a name and its click count. */
export interface ChannelCount {
  readonly name: string;
  readonly clicks: number;
}

/**
 * Comparator for channel entries: clicks descending, then name ascending.
 *
 * The name tie-break compares by UTF-16 code units with `<`/`>` rather than
 * `localeCompare`, whose result depends on the environment locale and would
 * make the ordering non-deterministic across machines.
 */
export function compareChannels(a: ChannelCount, b: ChannelCount): number {
  if (a.clicks !== b.clicks) {
    return b.clicks - a.clicks;
  }
  if (a.name < b.name) {
    return -1;
  }
  if (a.name > b.name) {
    return 1;
  }
  return 0;
}
