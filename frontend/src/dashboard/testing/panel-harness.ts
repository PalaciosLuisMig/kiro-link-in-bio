// Test harness: mounts the whole Panel against the fake server, a fake socket and a
// fake `sessionStorage`. For the happy-dom tests only.

import { vi } from 'vitest';

import type { AdminLink, MetricsSnapshot } from '@link-in-bio/shared';

import { startPanel, type PanelHandle } from '../app.js';
import type { TokenStorage } from '../auth.js';

import { emptySnapshot, FakeServer, FakeSocket, OWNER_TOKEN } from './fake-server.js';

export class FakeStorage implements TokenStorage {
  readonly values = new Map<string, string>();
  getItem = (key: string): string | null => this.values.get(key) ?? null;
  setItem = (key: string, value: string): void => void this.values.set(key, value);
  removeItem = (key: string): void => void this.values.delete(key);
}

export interface PanelHarness {
  readonly root: HTMLElement;
  readonly server: FakeServer;
  readonly sockets: FakeSocket[];
  readonly storage: FakeStorage;
  readonly handle: PanelHandle;
}

export interface MountOptions {
  /** A token already saved in sessionStorage, as after a reload. */
  readonly savedToken?: string | null;
  readonly links?: readonly AdminLink[];
  readonly snapshot?: MetricsSnapshot;
  /** Prepares the server before the Panel starts (a Panel with a saved token asks at once). */
  readonly configure?: (server: FakeServer) => void;
}

/** The fixed "now" of the tests: noon UTC on a given day. */
export const NOW = new Date('2026-11-03T12:00:00.000Z');

/** Starts fake time at {@link NOW}. Call it in `beforeEach`. */
export function startClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

export function mountPanel(options: MountOptions = {}): PanelHarness {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app') as HTMLElement;

  const server = new FakeServer();
  server.links = [...(options.links ?? [])];
  server.snapshot = options.snapshot ?? emptySnapshot();
  options.configure?.(server);

  const storage = new FakeStorage();
  if (options.savedToken !== undefined && options.savedToken !== null) {
    storage.setItem('link-in-bio.owner-token', options.savedToken);
  }

  const sockets: FakeSocket[] = [];
  const handle = startPanel(root, {
    fetch: server.fetch,
    storage,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: () => Date.now(),
    timeZone: 'UTC',
  });

  return { root, server, sockets, storage, handle };
}

/** Lets pending promises and short timers settle. */
export async function settle(ms = 10): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Types a token in the form and submits it. */
export async function signInWith(h: PanelHarness, token: string): Promise<void> {
  const input = h.root.querySelector<HTMLInputElement>('input[type="password"]');
  if (input === null) {
    throw new Error('the sign-in form is not shown');
  }
  input.value = token;
  const form = h.root.querySelector('form') as HTMLFormElement;
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}

/** Mounts, waits for the first screen and signs in with the right token. */
export async function mountSignedIn(options: MountOptions = {}): Promise<PanelHarness> {
  const h = mountPanel(options);
  await h.handle.ready;
  await signInWith(h, OWNER_TOKEN);
  await settle();
  return h;
}

export const text = (element: Element | null | undefined): string =>
  element?.textContent?.trim() ?? '';

export const all = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T[] => [
  ...root.querySelectorAll<T>(selector),
];

/** The button of a row (or the page) whose accessible name or text starts with `label`. */
export function buttonNamed(root: ParentNode, label: string): HTMLButtonElement {
  const found = all<HTMLButtonElement>(root, 'button').find((button) =>
    (button.getAttribute('aria-label') ?? button.textContent ?? '').trim().startsWith(label),
  );
  if (found === undefined) {
    throw new Error(`no button named "${label}"`);
  }
  return found;
}
