import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { validateTitle, validateUrl } from './link-rules.js';

// Minimal local declaration of the Node `process` global. `shared/` deliberately
// pulls in neither the Node nor DOM type libraries (`types: []`, `lib: ES2023`),
// and ESLint forbids the bare `process` global here. Declaring it locally mirrors
// the `declare const URL` pattern used in `link-rules.ts`: the reference resolves
// to this binding, so neither the type checker nor ESLint complains. Vitest
// injects `FC_NUM_RUNS` into `process.env` from the root config.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

// Minimal local declaration of the WHATWG `URL` global, mirroring `link-rules.ts`.
// `shared/` pulls in neither the Node nor DOM type libraries, so `URL` is not in
// scope by type; we declare only the surface this test reads.
interface UrlLike {
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
}
declare const URL: { new (input: string): UrlLike };

// Honour the shared fast-check budget (100 by default; the save hook lowers it to
// 20). Falls back to 100 when the variable is absent.
const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? '100');
const fcConfig: fc.Parameters<unknown> = { numRuns: NUM_RUNS };

/** Counts Unicode code points, matching the rule in `validateTitle`. */
function codePointLength(value: string): number {
  return [...value].length;
}

/** The exact control / bidi-control set rejected by the rules. */
const CONTROL_OR_BIDI = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;

describe('validateTitle (Property 8)', () => {
  // A valid title is always returned as its trimmed version and never exceeds 80
  // code points.
  test('a valid title is returned trimmed and within 80 code points', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = validateTitle(raw);
        if (result === null) {
          return true;
        }
        expect(result).toBe(raw.trim());
        expect(codePointLength(result)).toBeGreaterThanOrEqual(1);
        expect(codePointLength(result)).toBeLessThanOrEqual(80);
        expect(CONTROL_OR_BIDI.test(result)).toBe(false);
        return true;
      }),
      fcConfig,
    );
  });

  // Acceptance is exactly the specified predicate: 1..80 code points after trim,
  // with no control or bidi-control character.
  test('acceptance matches the trim + length + control predicate', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const trimmed = raw.trim();
        const length = codePointLength(trimmed);
        const expected = length >= 1 && length <= 80 && !CONTROL_OR_BIDI.test(trimmed);
        expect(validateTitle(raw) !== null).toBe(expected);
      }),
      fcConfig,
    );
  });

  // Rejection: any string containing a control or bidi-control character is
  // rejected (trim only strips whitespace/BOM, not interior controls).
  test('rejects titles containing a control or bidi-control character', () => {
    const controlChar = fc.oneof(
      fc.integer({ min: 0x00, max: 0x08 }),
      fc.integer({ min: 0x0b, max: 0x1f }),
      fc.constantFrom(0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069),
    );
    fc.assert(
      fc.property(fc.string(), controlChar, fc.string(), (prefix, code, suffix) => {
        const raw = `x${prefix}${String.fromCodePoint(code)}${suffix}x`;
        expect(validateTitle(raw)).toBeNull();
      }),
      fcConfig,
    );
  });

  // Rejection: a title whose trimmed length exceeds 80 code points is rejected.
  test('rejects titles longer than 80 code points after trim', () => {
    fc.assert(
      fc.property(fc.integer({ min: 81, max: 200 }), (length) => {
        const raw = 'a'.repeat(length);
        expect(validateTitle(raw)).toBeNull();
      }),
      fcConfig,
    );
  });

  // Rejection: an empty or whitespace-only title is rejected (length 0 after trim).
  test('rejects empty or whitespace-only titles', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[ \t\n\r]*$/), (raw) => {
        expect(validateTitle(raw)).toBeNull();
      }),
      fcConfig,
    );
  });
});

describe('validateUrl (Property 8)', () => {
  // A generator of URLs the rule should accept: http/https scheme, non-empty
  // host, no credentials, no spaces or control characters.
  const acceptableUrl = fc
    .tuple(
      fc.constantFrom('http', 'https', 'HTTP', 'Https'),
      fc.domain(),
      fc.webPath().filter((path) => !/\s/.test(path) && !CONTROL_OR_BIDI.test(path)),
    )
    .map(([scheme, host, path]) => `${scheme}://${host}${path}`)
    .filter((url) => url.length <= 2048);

  // Any accepted URL is returned exactly as received (no trim) and satisfies the
  // scheme / host / credential invariants.
  test('an accepted URL is returned unchanged and satisfies the invariants', () => {
    fc.assert(
      fc.property(acceptableUrl, (url) => {
        const result = validateUrl(url);
        expect(result).toBe(url);
        expect(/^https?:\/\/[^/]/i.test(url)).toBe(true);
        expect(/\s/.test(url)).toBe(false);
        expect(CONTROL_OR_BIDI.test(url)).toBe(false);
        const parsed = new URL(url);
        expect(parsed.username).toBe('');
        expect(parsed.password).toBe('');
        expect(parsed.hostname).not.toBe('');
      }),
      fcConfig,
    );
  });

  // Whatever `validateUrl` returns is never a trimmed variant: it is identical to
  // the input or null.
  test('never trims: the result is the exact input or null', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = validateUrl(raw);
        expect(result === null || result === raw).toBe(true);
      }),
      fcConfig,
    );
  });

  // Rejection: a URL containing any whitespace is rejected.
  test('rejects URLs containing whitespace', () => {
    fc.assert(
      fc.property(fc.domain(), fc.constantFrom(' ', '\t', '\n', '\r'), (host, space) => {
        expect(validateUrl(`http://${host}/a${space}b`)).toBeNull();
      }),
      fcConfig,
    );
  });

  // Rejection: a URL with embedded credentials is rejected.
  test('rejects URLs carrying credentials', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,8}$/),
        fc.stringMatching(/^[a-z]{1,8}$/),
        fc.domain(),
        (user, pass, host) => {
          expect(validateUrl(`http://${user}:${pass}@${host}/`)).toBeNull();
        },
      ),
      fcConfig,
    );
  });

  // Rejection: any scheme other than http/https is rejected on the original
  // string before parsing.
  test('rejects schemes other than http/https', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('ftp', 'ws', 'file', 'javascript', 'mailto', 'data'),
        fc.domain(),
        (scheme, host) => {
          expect(validateUrl(`${scheme}://${host}/`)).toBeNull();
        },
      ),
      fcConfig,
    );
  });
});

describe('validateTitle (mandatory unit cases)', () => {
  // 80 code points of emoji is valid; 81 is not. Emojis are astral characters:
  // each is a single code point but two UTF-16 code units, so this distinguishes
  // code-point counting from `.length`.
  test('80 emoji code points are valid, 81 are not', () => {
    const emoji = '😀';
    const title80 = emoji.repeat(80);
    const title81 = emoji.repeat(81);
    expect(codePointLength(title80)).toBe(80);
    expect(codePointLength(title81)).toBe(81);
    expect(validateTitle(title80)).toBe(title80);
    expect(validateTitle(title81)).toBeNull();
  });

  // An interior newline is a control character and is rejected.
  test('a title with an interior newline is rejected', () => {
    expect(validateTitle('hello\nworld')).toBeNull();
  });

  // A trailing newline is stripped by trim, so the title is accepted trimmed.
  test('a title with a trailing newline is valid and trimmed', () => {
    expect(validateTitle('hello\n')).toBe('hello');
  });
});

describe('validateUrl (mandatory unit cases)', () => {
  // Single slash after the scheme: fails the `http(s)://` prefix check.
  test('rejects a scheme with a single slash', () => {
    expect(validateUrl('https:/ejemplo.com')).toBeNull();
  });

  // Three slashes leave an empty authority: the character after `//` is `/`.
  test('rejects an empty authority (three slashes)', () => {
    expect(validateUrl('http:///ejemplo.com')).toBeNull();
  });

  // A space in the path is rejected.
  test('rejects a URL with a space in the path', () => {
    expect(validateUrl('http://a.com/a b')).toBeNull();
  });

  // Embedded credentials are rejected.
  test('rejects a URL with embedded credentials', () => {
    expect(validateUrl('http://user:pass@a.com')).toBeNull();
  });

  // A non-http(s) scheme is rejected.
  test('rejects the javascript scheme', () => {
    expect(validateUrl('javascript:alert(1)')).toBeNull();
  });

  // An empty host is rejected. `http://:80/` parses with an empty hostname.
  test('rejects a URL with an empty host', () => {
    expect(validateUrl('http://:80/')).toBeNull();
  });
});
