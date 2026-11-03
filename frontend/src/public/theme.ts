// Theme button: lets the visitor switch between the light and the dark theme.
//
// Privacy (Requirement 11.3): the page must not create cookies nor write to
// `localStorage` or `sessionStorage`. So the choice is NOT remembered: it lasts
// while the page stays open, and a new visit starts from the system theme again.
//
// The choice is written as `data-theme` on `<html>`; the CSS gives it priority
// over the system preference in both directions. Everything the logic touches is
// injected, so it is tested without a browser.

import { MESSAGES } from '../lib/messages.js';

export type Theme = 'light' | 'dark';

/**
 * Page background of each theme, for the browser's `theme-color`. They repeat
 * `--color-bg` of `styles.css`; the style test fails if they ever differ.
 */
export const THEME_COLORS: Readonly<Record<Theme, string>> = {
  light: '#e9eff6',
  dark: '#0b1626',
};

/** The part of `MediaQueryList` the button uses (so a test can fake it). */
export interface PrefersDark {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
}

export interface ThemeDeps {
  /** The element that receives `data-theme` (`document.documentElement`). */
  readonly root: HTMLElement;
  /** The theme button, hidden in the HTML until this function enables it. */
  readonly button: HTMLButtonElement;
  /** `matchMedia('(prefers-color-scheme: dark)')`. */
  readonly prefersDark: PrefersDark;
  /** The `<meta name="theme-color">` elements. */
  readonly metas: Iterable<HTMLMetaElement>;
}

/**
 * Wires the theme button.
 *
 * - Starts from the system theme and shows the button (a toggle between two
 *   themes: its icon and label always name the theme it switches TO).
 * - A click chooses the other theme, which then wins over the system one.
 * - While the visitor has not chosen, a change of the system theme updates the
 *   button; after a choice it is ignored.
 * - On a choice the browser's `theme-color` follows, so the address bar of a
 *   phone matches the page.
 */
export function startThemeToggle(deps: ThemeDeps): void {
  const { root, button, prefersDark } = deps;
  let chosen: Theme | null = null;

  const current = (): Theme => chosen ?? (prefersDark.matches ? 'dark' : 'light');

  const render = (): void => {
    const next: Theme = current() === 'dark' ? 'light' : 'dark';
    button.dataset.next = next;
    button.setAttribute(
      'aria-label',
      next === 'dark' ? MESSAGES.themeToDark : MESSAGES.themeToLight,
    );
  };

  button.hidden = false;
  render();

  button.addEventListener('click', () => {
    chosen = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = chosen;
    for (const meta of deps.metas) {
      meta.setAttribute('content', THEME_COLORS[chosen]);
      meta.removeAttribute('media');
    }
    render();
  });

  prefersDark.addEventListener('change', () => {
    if (chosen === null) {
      render();
    }
  });
}
