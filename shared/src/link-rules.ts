// Validation rules for link titles and destination URLs.
// Pure TypeScript only: no Node, DOM, or AWS imports.
//
// These functions are the single source of truth for the title/URL rules and
// are reused by the Zod request schemas (via `.refine`) and the domain use
// cases, so the exact same logic runs everywhere.

// Minimal local declaration of the WHATWG `URL` global. `URL` is a standard
// runtime global in both the browser and Node, but it is not part of the
// `ES2023` lib, and `shared/` deliberately pulls in neither the DOM nor Node
// type libraries. We declare only the surface we use.
interface UrlLike {
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
}
interface UrlConstructor {
  new (input: string): UrlLike;
}
declare const URL: UrlConstructor;

/** Maximum title length, counted in Unicode code points. */
const MAX_TITLE_CODE_POINTS = 80;

/** Maximum URL length, counted in UTF-16 code units. */
const MAX_URL_LENGTH = 2048;

/**
 * Matches a control character (Unicode category Cc, which includes line
 * breaks) or a bidirectional-control character (U+202A..U+202E, U+2066..U+2069).
 */
const CONTROL_OR_BIDI = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;

/**
 * Validates a raw link title.
 *
 * Applies JavaScript `trim()` (which strips spaces, trailing line breaks, NBSP
 * and BOM, so a trailing `\n` is accepted but an interior one is rejected as a
 * control character). Accepts when the trimmed value has 1 to 80 code points
 * and contains no control or bidi-control characters.
 *
 * @returns the trimmed title when valid, or `null` when invalid.
 */
export function validateTitle(raw: string): string | null {
  const trimmed = raw.trim();
  const codePointLength = [...trimmed].length;
  if (codePointLength < 1 || codePointLength > MAX_TITLE_CODE_POINTS) {
    return null;
  }
  if (CONTROL_OR_BIDI.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Validates a raw destination URL.
 *
 * Checks the original string first: it must start with `http://` or `https://`
 * (case-insensitive) followed by a character other than `/`, contain no spaces
 * or control characters, and be 1 to 2048 characters long. Then parses it with
 * `new URL` and rejects a non-empty `username`/`password` or an empty host. The
 * value is returned exactly as received (no trim).
 *
 * @returns the URL as received when valid, or `null` when invalid.
 */
export function validateUrl(raw: string): string | null {
  if (raw.length < 1 || raw.length > MAX_URL_LENGTH) {
    return null;
  }
  if (!/^https?:\/\/[^/]/i.test(raw)) {
    return null;
  }
  if (/\s/.test(raw) || CONTROL_OR_BIDI.test(raw)) {
    return null;
  }

  let parsed: UrlLike;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.username !== '' || parsed.password !== '' || parsed.hostname === '') {
    return null;
  }

  return raw;
}
