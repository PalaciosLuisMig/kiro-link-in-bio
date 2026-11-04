// Entry point of the Panel. It only reads the browser globals and starts the Panel;
// the logic lives in `app.ts` and its parts.

import '../public/styles.css';
import './styles.css';

import { startThemeToggle } from '../public/theme.js';

import { startPanel } from './app.js';
import { createBrowserSocket } from './socket.js';

const root = document.getElementById('app');

if (root !== null) {
  /** `sessionStorage` can throw when site data is blocked; the session then lives in memory. */
  const storage = ((): Storage | null => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  })();

  startPanel(root, {
    fetch: (input, init) => fetch(input, init),
    storage,
    createSocket: (url) => createBrowserSocket(url),
    now: () => Date.now(),
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
