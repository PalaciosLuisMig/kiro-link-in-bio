// Entry point of the public page. It only reads the browser globals and starts
// the page; the logic lives in `page.ts` and `theme.ts`.

import './styles.css';

import { startPublicPage } from './page.js';
import { startThemeToggle } from './theme.js';

const container = document.getElementById('content');

if (container !== null) {
  void startPublicPage(container, {
    fetch: (input, init) => fetch(input, init),
    navigate: (url) => location.assign(url),
    search: location.search,
  });
}

const themeButton = document.querySelector<HTMLButtonElement>('.theme-toggle');

if (themeButton !== null) {
  startThemeToggle({
    root: document.documentElement,
    button: themeButton,
    prefersDark: matchMedia('(prefers-color-scheme: dark)'),
    metas: document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
  });
}
