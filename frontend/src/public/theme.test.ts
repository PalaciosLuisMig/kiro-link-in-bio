// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { MESSAGES } from '../lib/messages.js';

import { startThemeToggle, THEME_COLORS } from './theme.js';

// Tests of the theme button: it starts from the system theme, a click chooses the
// other one and that choice beats the system, the browser's theme color follows,
// and nothing is written to cookies or storage.
//
// Validates: Requirements 11.3, 13.3, 13.5.

/** A `matchMedia` double whose result the test can change and announce. */
class FakePrefersDark {
  private listeners: (() => void)[] = [];

  constructor(public matches: boolean) {}

  addEventListener(_type: 'change', listener: () => void): void {
    this.listeners.push(listener);
  }

  /** The system theme changes (the visitor switches the OS theme). */
  set(matches: boolean): void {
    this.matches = matches;
    this.listeners.forEach((listener) => listener());
  }
}

interface Harness {
  readonly root: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly metas: HTMLMetaElement[];
  readonly system: FakePrefersDark;
}

function harness(systemDark: boolean): Harness {
  document.documentElement.removeAttribute('data-theme');
  document.head.innerHTML = `
    <meta name="theme-color" content="${THEME_COLORS.light}" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="${THEME_COLORS.dark}" media="(prefers-color-scheme: dark)" />`;
  document.body.innerHTML =
    '<button type="button" class="theme-toggle" hidden aria-label="Cambiar tema"></button>';

  const button = document.querySelector('.theme-toggle') as HTMLButtonElement;
  const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  const system = new FakePrefersDark(systemDark);
  startThemeToggle({ root: document.documentElement, button, prefersDark: system, metas });
  return { root: document.documentElement, button, metas, system };
}

let h: Harness;

describe('light system theme', () => {
  beforeEach(() => {
    h = harness(false);
  });

  test('shows the button and offers to go dark', () => {
    expect(h.button.hidden).toBe(false);
    expect(h.button.dataset.next).toBe('dark');
    expect(h.button.getAttribute('aria-label')).toBe(MESSAGES.themeToDark);
  });

  test('sets no theme by itself: the CSS follows the system until a choice', () => {
    expect(h.root.dataset.theme).toBeUndefined();
  });

  test('a click chooses dark and then the button offers light', () => {
    h.button.click();
    expect(h.root.dataset.theme).toBe('dark');
    expect(h.button.dataset.next).toBe('light');
    expect(h.button.getAttribute('aria-label')).toBe(MESSAGES.themeToLight);
  });

  test('a second click goes back to light, as an explicit choice', () => {
    h.button.click();
    h.button.click();
    expect(h.root.dataset.theme).toBe('light');
    expect(h.button.dataset.next).toBe('dark');
    expect(h.button.getAttribute('aria-label')).toBe(MESSAGES.themeToDark);
  });
});

describe('dark system theme', () => {
  beforeEach(() => {
    h = harness(true);
  });

  test('offers to go light', () => {
    expect(h.button.dataset.next).toBe('light');
    expect(h.button.getAttribute('aria-label')).toBe(MESSAGES.themeToLight);
  });

  test('a click chooses light, which beats the dark system theme', () => {
    h.button.click();
    expect(h.root.dataset.theme).toBe('light');
    expect(h.button.dataset.next).toBe('dark');
  });
});

describe('system theme changes', () => {
  test('before any choice the button follows the system theme', () => {
    h = harness(false);
    h.system.set(true);
    expect(h.button.dataset.next).toBe('light');
    h.system.set(false);
    expect(h.button.dataset.next).toBe('dark');
    expect(h.root.dataset.theme).toBeUndefined();
  });

  test('after a choice the system theme is ignored', () => {
    h = harness(false);
    h.button.click(); // chose dark
    h.system.set(true);
    h.system.set(false);
    expect(h.root.dataset.theme).toBe('dark');
    expect(h.button.dataset.next).toBe('light');
  });
});

describe("browser's theme color", () => {
  test('is untouched until the visitor chooses', () => {
    h = harness(false);
    expect(h.metas.map((meta) => meta.getAttribute('content'))).toEqual([
      THEME_COLORS.light,
      THEME_COLORS.dark,
    ]);
    expect(h.metas.every((meta) => meta.hasAttribute('media'))).toBe(true);
  });

  test('follows the chosen theme, with no media condition left to override it', () => {
    h = harness(false);
    h.button.click(); // dark
    expect(h.metas.map((meta) => meta.getAttribute('content'))).toEqual([
      THEME_COLORS.dark,
      THEME_COLORS.dark,
    ]);
    expect(h.metas.some((meta) => meta.hasAttribute('media'))).toBe(false);

    h.button.click(); // light
    expect(h.metas.map((meta) => meta.getAttribute('content'))).toEqual([
      THEME_COLORS.light,
      THEME_COLORS.light,
    ]);
  });
});

describe('privacy (Requirement 11.3)', () => {
  test('choosing a theme writes no cookie and no local or session storage', () => {
    // Start from an empty state and watch the writes themselves. Comparing the
    // storage length with a baseline taken here would miss a write to a key that an
    // earlier test already created (it did: the mutation check caught it).
    window.localStorage.clear();
    window.sessionStorage.clear();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    h = harness(false);

    h.button.click();
    h.button.click();
    h.button.click();

    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    setItem.mockRestore();
  });

  test('a new page load starts from the system theme again (the choice is not kept)', () => {
    h = harness(false);
    h.button.click();
    expect(h.root.dataset.theme).toBe('dark');

    const fresh = harness(false);
    expect(fresh.root.dataset.theme).toBeUndefined();
    expect(fresh.button.dataset.next).toBe('dark');
  });
});

describe('accessibility', () => {
  test('is a real button that does not submit anything', () => {
    h = harness(false);
    expect(h.button.tagName).toBe('BUTTON');
    expect(h.button.type).toBe('button');
  });

  test('its accessible name always says what a click does, in Spanish', () => {
    h = harness(false);
    const names = new Set<string>();
    for (let click = 0; click < 4; click += 1) {
      names.add(h.button.getAttribute('aria-label') ?? '');
      h.button.click();
    }
    expect([...names].sort()).toEqual([MESSAGES.themeToDark, MESSAGES.themeToLight].sort());
  });
});
