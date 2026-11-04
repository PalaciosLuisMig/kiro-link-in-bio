/// <reference types="node" />
import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { contrastRatio } from '../lib/contrast.js';

// Tests of the Panel's styles and page (tasks 15.11, 15.12): the colors it adds in
// both themes, the table that stays readable for a screen reader, the size of its
// buttons, the page head and the rules of its content security policy.
//
// Validates: Requirements 15.2, 15.3, 15.4, 15.5, 15.6, 17.4.

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const panelCss = read('./styles.css');
const publicCss = read('../public/styles.css');
const html = read('../../panel.html');
const mainSource = read('./main.ts');

/** A `--name: #hex;` declaration in a block of CSS. */
function variable(block: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})\\s*;`).exec(block);
  if (match === null) {
    throw new Error(`--${name} not found`);
  }
  return match[1] as string;
}

const lightBlock = /:root\s*\{([^}]*)\}/.exec(panelCss)?.[1] ?? '';
const darkSystemBlock =
  /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/.exec(
    panelCss,
  )?.[1] ?? '';
const darkChosenBlock = /:root\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(panelCss)?.[1] ?? '';

const publicLight = /:root\s*\{([^}]*)\}/.exec(publicCss)?.[1] ?? '';
const publicDark =
  /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/.exec(
    publicCss,
  )?.[1] ?? '';

describe.each([
  ['light', lightBlock, publicLight],
  ['dark (system)', darkSystemBlock, publicDark],
  ['dark (chosen)', darkChosenBlock, publicDark],
])('%s theme colors of the Panel', (_name, block, shared) => {
  test('the danger button label has at least 4.5:1 on its background (15.4)', () => {
    expect(
      contrastRatio(variable(block, 'color-on-danger'), variable(block, 'color-danger')),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test('the chart bars stand out from the chart background (3:1)', () => {
    const key = variable(shared, 'color-key');
    expect(contrastRatio(variable(shared, 'color-accent'), key)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(variable(shared, 'color-ink'), key)).toBeGreaterThanOrEqual(3);
  });

  test('the text of the cards, rows and tables has 4.5:1 on its face', () => {
    expect(
      contrastRatio(variable(shared, 'color-ink'), variable(shared, 'color-key')),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test('the focus ring has 3:1 against the page and against the card faces (15.4)', () => {
    const focus = variable(shared, 'color-focus');
    expect(contrastRatio(focus, variable(shared, 'color-bg'))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(focus, variable(shared, 'color-key'))).toBeGreaterThanOrEqual(3);
  });
});

describe('the Panel palette', () => {
  test('the dark danger colors are the same whether the system or the visitor chose dark', () => {
    expect(variable(darkChosenBlock, 'color-danger')).toBe(
      variable(darkSystemBlock, 'color-danger'),
    );
    expect(variable(darkChosenBlock, 'color-on-danger')).toBe(
      variable(darkSystemBlock, 'color-on-danger'),
    );
  });

  test('the dark danger colors differ from the light ones', () => {
    expect(variable(darkSystemBlock, 'color-danger')).not.toBe(
      variable(lightBlock, 'color-danger'),
    );
  });
});

describe('visually hidden content (15.2)', () => {
  const rule = /\.visually-hidden\s*\{([^}]*)\}/.exec(panelCss)?.[1] ?? '';

  test('uses the clip technique', () => {
    expect(rule).toMatch(/clip:\s*rect\(0 0 0 0\)/);
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/overflow:\s*hidden/);
  });

  test('is NEVER display:none, visibility:hidden or opacity:0, which hide it from a screen reader', () => {
    expect(rule).not.toMatch(/display:\s*none/);
    expect(rule).not.toMatch(/visibility:\s*hidden/);
    expect(rule).not.toMatch(/opacity:\s*0/);
    expect(rule).not.toMatch(/width:\s*0[;\s]/);
  });
});

describe('layout and interaction rules', () => {
  test('buttons and fields are at least 44 px tall', () => {
    expect(panelCss).toMatch(/\.button\s*\{[^}]*min-height:\s*2\.75rem/);
    expect(panelCss).toMatch(/\.field\s*\{[^}]*min-height:\s*2\.75rem/);
  });

  test('hover only applies where there is a real pointer', () => {
    expect(panelCss).toMatch(/:hover/);
    const outside = panelCss.replace(
      /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g,
      '',
    );
    expect(outside).not.toMatch(/:hover/);
  });

  test('has a visible focus ring for buttons, fields and the section title', () => {
    expect(panelCss).toMatch(/\.button:focus-visible/);
    expect(panelCss).toMatch(/\.field:focus-visible/);
    expect(panelCss).toMatch(/\.section-title:focus-visible/);
    expect(panelCss).toMatch(/outline:\s*3px solid var\(--color-focus\)/);
  });

  test('turns the transitions off for reduced motion (15.6)', () => {
    expect(panelCss).toMatch(
      /prefers-reduced-motion:\s*reduce[\s\S]*\.button[\s\S]*transition:\s*none/,
    );
  });

  test('defines no animation at all, so nothing moves in the chart, counters or feed (15.6)', () => {
    expect(panelCss).not.toMatch(/@keyframes|animation\s*:/);
  });

  test('a long title or url wraps instead of overflowing', () => {
    expect(panelCss).toMatch(/\.link-title\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(panelCss).toMatch(/\.link-url\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  test('uses system fonts only and loads nothing remote', () => {
    expect(panelCss).not.toMatch(/@font-face|@import|url\(\s*['"]?https?:/i);
  });

  test('is wider than the public page and has a two-column layout on large screens', () => {
    expect(panelCss).toMatch(/\.panel-page main\s*\{[^}]*max-width:\s*72rem/);
    expect(panelCss).toMatch(/@media\s*\(min-width:\s*60rem\)/);
  });

  test('on a phone the two columns dissolve into one list; on a wide screen they are real columns', () => {
    // Found by looking at the page: with one grid of rows, the tall links column
    // stretched the first row and left a big gap between the totals and the chart.
    expect(panelCss).toMatch(/\.panel-col\s*\{[^}]*display:\s*contents/);
    const wide = /@media\s*\(min-width:\s*60rem\)\s*\{([\s\S]*?)\n\}/.exec(panelCss)?.[1] ?? '';
    expect(wide).toMatch(/\.panel-col\s*\{[^}]*display:\s*grid/);
    expect(wide).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    // No grid areas that would tie the two columns to the same rows again.
    expect(panelCss).not.toMatch(/grid-template-areas|grid-area/);
  });

  test('on a phone the sections read: totals, chart, links, channels, feed (order)', () => {
    const order = (name: string): number =>
      Number(
        new RegExp(`\\.panel-section--${name}\\s*\\{[^}]*order:\\s*(\\d+)`).exec(panelCss)?.[1] ??
          NaN,
      );
    const names = ['totals', 'chart', 'links', 'channels', 'feed'];
    expect(names.map(order)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('panel.html', () => {
  test('is in Spanish, with a descriptive title and a single h1 (15.5)', () => {
    expect(html).toMatch(/<html lang="es">/);
    expect(html).toMatch(/<title>[^<]{5,}<\/title>/);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toMatch(/<h1>Panel de control<\/h1>/);
  });

  test('asks search engines not to index it, as the server header also does', () => {
    expect(html).toMatch(/<meta name="robots" content="noindex"/);
  });

  test('has the theme button, hidden until the script wires it', () => {
    const button = /<button[^>]*class="theme-toggle"[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).toMatch(/type="button"/);
    expect(button).toMatch(/\shidden[\s>]/);
  });

  test('has no inline style and no inline script, which the content security policy blocks', () => {
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toMatch(/\son[a-z]+="/i);
  });

  test('loads nothing from another origin', () => {
    expect(html).not.toMatch(/(src|href)="https?:\/\//);
  });

  test('has the mount point the script looks for, and its own entry script', () => {
    expect(html).toMatch(/<div id="app"><\/div>/);
    expect(html).toMatch(/<script type="module" src="\/src\/dashboard\/main\.ts"><\/script>/);
  });
});

describe('the Panel entry point', () => {
  test('loads the public styles first, then its own, so it can build on them', () => {
    const publicAt = mainSource.indexOf("'../public/styles.css'");
    const panelAt = mainSource.indexOf("'./styles.css'");
    expect(publicAt).toBeGreaterThan(-1);
    expect(panelAt).toBeGreaterThan(publicAt);
  });

  test('keeps the token out of the page: it reads sessionStorage, never local storage or cookies', () => {
    expect(mainSource).toMatch(/window\.sessionStorage/);
    expect(mainSource).not.toMatch(/localStorage|document\.cookie/);
  });
});
