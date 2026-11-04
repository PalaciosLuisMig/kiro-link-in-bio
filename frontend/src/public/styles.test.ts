/// <reference types="node" />
import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { contrastRatio, parseHex } from '../lib/contrast.js';

import { THEME_COLORS } from './theme.js';

// Vitest returns an empty string for `.css?raw` (it does not process CSS by default),
// so the real files are read from disk.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

// Tests of the colors and layout rules of the public page (task 14.7). The
// colors are CSS variables in a light and a dark palette, so the pairs that carry
// text can be checked against 4.5:1 and the focus ring against 3:1, for both,
// without a browser.
//
// Validates: Requirements 13.3, 13.4, 13.6, 13.8.

const COLOR_NAMES = [
  'color-bg',
  'color-ink',
  'color-key',
  'color-accent',
  'color-on-accent',
  'color-focus',
] as const;
type Palette = Record<(typeof COLOR_NAMES)[number], string>;

/** Reads the six color variables declared in a block of CSS declarations. */
function palette(block: string): Palette {
  const read = (name: string): string => {
    const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})\\s*;`).exec(block);
    if (match === null) {
      throw new Error(`CSS variable --${name} not found or not a hex color`);
    }
    return match[1] as string;
  };
  return Object.fromEntries(COLOR_NAMES.map((name) => [name, read(name)])) as Palette;
}

const lightBlock = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
// Dark because the SYSTEM prefers it (and the visitor has not chosen light)...
const darkBlock =
  /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/.exec(
    css,
  )?.[1] ?? '';
// ...and dark because the VISITOR chose it with the theme button.
const chosenDarkBlock = /:root\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

describe('contrastRatio', () => {
  test('matches the known WCAG extremes', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5);
  });

  test('is symmetric', () => {
    expect(contrastRatio('#1d4ed8', '#e9eff6')).toBeCloseTo(
      contrastRatio('#e9eff6', '#1d4ed8'),
      10,
    );
  });

  test('a known mid pair: #767676 on white is just above 4.5:1', () => {
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.6);
  });

  test('rejects invalid colors instead of returning nonsense', () => {
    expect(() => contrastRatio('red', '#fff')).toThrow();
    expect(parseHex('#12')).toBeNull();
  });
});

describe('palettes', () => {
  test('the light and the dark palette both exist and define the six colors', () => {
    expect(lightBlock).not.toBe('');
    expect(darkBlock).not.toBe('');
    expect(() => palette(lightBlock)).not.toThrow();
    expect(() => palette(darkBlock)).not.toThrow();
  });

  test('the page declares that it supports both color schemes', () => {
    expect(css).toMatch(/color-scheme:\s*light dark/);
  });

  test('the dark palette really differs from the light one', () => {
    expect(palette(darkBlock)['color-bg']).not.toBe(palette(lightBlock)['color-bg']);
    expect(palette(darkBlock)['color-ink']).not.toBe(palette(lightBlock)['color-ink']);
  });

  test('the dark palette is the same whether the system or the visitor chose it', () => {
    expect(chosenDarkBlock).not.toBe('');
    expect(palette(chosenDarkBlock)).toEqual(palette(darkBlock));
  });

  test('a visitor choice beats the system in both directions', () => {
    // The system-dark rule leaves out an explicit light choice...
    expect(css).toMatch(/:root:not\(\[data-theme='light'\]\)/);
    // ...an explicit dark choice has its own rule, and each sets its color-scheme.
    expect(chosenDarkBlock).toMatch(/color-scheme:\s*dark/);
    expect(css).toMatch(/:root\[data-theme='light'\]\s*\{[^}]*color-scheme:\s*light/);
  });

  test('the browser theme colors repeat the page background of each palette', () => {
    expect(THEME_COLORS.light).toBe(palette(lightBlock)['color-bg']);
    expect(THEME_COLORS.dark).toBe(palette(darkBlock)['color-bg']);
  });
});

describe.each([
  ['light', lightBlock],
  ['dark (system)', darkBlock],
  ['dark (chosen)', chosenDarkBlock],
])('%s palette contrast', (_name, block) => {
  const colors = palette(block);

  test('page text on the page background is at least 4.5:1', () => {
    expect(contrastRatio(colors['color-ink'], colors['color-bg'])).toBeGreaterThanOrEqual(4.5);
  });

  test('link text on the link face is at least 4.5:1', () => {
    expect(contrastRatio(colors['color-ink'], colors['color-key'])).toBeGreaterThanOrEqual(4.5);
  });

  test('the "Reintentar" label on its button is at least 4.5:1', () => {
    expect(contrastRatio(colors['color-on-accent'], colors['color-accent'])).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  test('the focus ring against the adjacent background is at least 3:1', () => {
    expect(contrastRatio(colors['color-focus'], colors['color-bg'])).toBeGreaterThanOrEqual(3);
  });

  test('the key edge and the retry button are visible against the page background (3:1)', () => {
    expect(contrastRatio(colors['color-ink'], colors['color-bg'])).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(colors['color-accent'], colors['color-bg'])).toBeGreaterThanOrEqual(3);
  });

  test('the link face is distinguishable from the page background', () => {
    expect(contrastRatio(colors['color-key'], colors['color-bg'])).toBeGreaterThan(1.05);
  });
});

describe('layout rules', () => {
  test('every link and the retry button are at least 44 px tall', () => {
    const heights = [...css.matchAll(/--tap-height:\s*([\d.]+)rem/g)].map((m) => Number(m[1]) * 16);
    // The base value and the one for wide screens (1rem = 16 px by default).
    expect(heights.length).toBeGreaterThanOrEqual(2);
    for (const height of heights) {
      expect(height).toBeGreaterThanOrEqual(44);
    }
    expect(css).toMatch(/\.link\s*\{[^}]*min-height:\s*var\(--tap-height\)/);
    expect(css).toMatch(/\.retry\s*\{[^}]*min-height:\s*var\(--tap-height\)/);
  });

  test('a long title without spaces wraps instead of overflowing', () => {
    expect(css).toMatch(/\.link\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  test('has a visible focus style for links and the retry button', () => {
    expect(css).toMatch(/\.link:focus-visible[\s\S]*outline:\s*3px solid var\(--color-focus\)/);
    expect(css).toMatch(/\.retry:focus-visible/);
  });

  test('hover only applies where there is a real pointer, never on touch', () => {
    expect(css).toMatch(/:hover/);
    // Remove every `(hover: hover) and (pointer: fine)` block; no `:hover` may remain.
    const outside = css.replace(
      /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g,
      '',
    );
    expect(outside).not.toMatch(/:hover/);
  });

  test('a press wins over hover: the :active rules come after the hover rules', () => {
    expect(css.indexOf('.link:active')).toBeGreaterThan(css.lastIndexOf('.link:hover'));
    expect(css.indexOf('.retry:active')).toBeGreaterThan(css.lastIndexOf('.retry:hover'));
  });

  test('turns animations off when the visitor asks for reduced motion', () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*transition:\s*none/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*animation:\s*none/);
  });

  test('uses system fonts only and no remote resources', () => {
    expect(css).not.toMatch(/@font-face|@import|url\(\s*['"]?https?:/i);
  });

  test('has a larger layout for wide screens', () => {
    expect(css).toMatch(/@media\s*\(min-width:\s*40rem\)/);
  });
});

describe('theme button rules', () => {
  test('is at least 44 x 44 px', () => {
    const size = /\.theme-toggle\s*\{[^}]*width:\s*([\d.]+)rem;[^}]*height:\s*([\d.]+)rem/.exec(
      css,
    );
    expect(size).not.toBeNull();
    expect(Number(size?.[1]) * 16).toBeGreaterThanOrEqual(44);
    expect(Number(size?.[2]) * 16).toBeGreaterThanOrEqual(44);
  });

  test('stays hidden while the script has not enabled it', () => {
    expect(css).toMatch(/\.theme-toggle\[hidden\]\s*\{[^}]*display:\s*none/);
  });

  test('shows only the icon of the theme it switches to', () => {
    expect(css).toMatch(/\.theme-toggle\[data-next='dark'\]\s+\.icon-moon/);
    expect(css).toMatch(/\.theme-toggle\[data-next='light'\]\s+\.icon-sun/);
  });

  test('has hover, press, focus and reduced-motion rules like the other keys', () => {
    expect(css).toMatch(/\.theme-toggle:hover/);
    expect(css).toMatch(/\.theme-toggle:focus-visible/);
    expect(css.indexOf('.theme-toggle:active')).toBeGreaterThan(
      css.lastIndexOf('.theme-toggle:hover'),
    );
    expect(css).toMatch(
      /prefers-reduced-motion:\s*reduce[\s\S]*\.theme-toggle[\s\S]*transition:\s*none/,
    );
  });
});

describe('document head', () => {
  test('declares Spanish, a descriptive title and a single h1', () => {
    expect(html).toMatch(/<html lang="es">/);
    expect(html).toMatch(/<title>[^<]{5,}<\/title>/);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  test('has an inline icon, so the browser does not request /favicon.ico', () => {
    expect(html).toMatch(/<link\s+rel="icon"[^>]*href="data:image\/svg\+xml,/);
  });

  test('the theme colors match the page background of each palette', () => {
    expect(html).toMatch(/content="#e9eff6"\s+media="\(prefers-color-scheme: light\)"/);
    expect(html).toMatch(/content="#0b1626"\s+media="\(prefers-color-scheme: dark\)"/);
    expect(palette(lightBlock)['color-bg']).toBe('#e9eff6');
    expect(palette(darkBlock)['color-bg']).toBe('#0b1626');
  });

  test('has the theme button: a real button, hidden until the script wires it', () => {
    const button = /<button[^>]*class="theme-toggle"[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).toMatch(/type="button"/);
    expect(button).toMatch(/\shidden[\s>]/);
    expect(button).toMatch(/aria-label="[^"]+"/);
  });

  test('the theme icons are decorative: hidden from assistive technology', () => {
    const icons = html.match(/<svg[^>]*class="icon-(?:moon|sun)"[^>]*>/g) ?? [];
    expect(icons).toHaveLength(2);
    for (const icon of icons) {
      expect(icon).toMatch(/aria-hidden="true"/);
    }
  });

  test('uses no inline style or script, which the CSP would block', () => {
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
  });

  test('loads nothing from another origin (the CSP only allows the same one)', () => {
    expect(html).not.toMatch(/(src|href)="https?:\/\//);
  });
});
