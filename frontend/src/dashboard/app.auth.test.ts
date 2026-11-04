// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OWNER_TOKEN } from './testing/fake-server.js';
import {
  all,
  mountPanel,
  mountSignedIn,
  settle,
  signInWith,
  startClock,
  text,
} from './testing/panel-harness.js';

// Tests of the Panel's session through the whole app (tasks 15.6, 15.7, 15.10):
// the form, the messages, the saved token and the real-time connection that follows.
//
// Validates: Requirements 5.1, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 5.14, 10.5, 10.7.

const TOKEN_KEY = 'link-in-bio.owner-token';

beforeEach(() => {
  startClock();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the sign-in form', () => {
  test('without a saved token it shows the form and sends no request', async () => {
    const h = mountPanel();
    await h.handle.ready;

    expect(h.root.querySelector('form.login')).not.toBeNull();
    expect(text(h.root.querySelector('label'))).toBe('Token del propietario');
    const field = h.root.querySelector<HTMLInputElement>('input#owner-token');
    expect(field?.type).toBe('password');
    expect(field?.getAttribute('autocomplete')).toBe('off');
    expect(h.server.calls).toHaveLength(0);
  });

  test('an empty or all-whitespace token shows "El token es obligatorio" and sends nothing (5.12)', async () => {
    const h = mountPanel();
    await h.handle.ready;

    for (const value of ['', '   ', '\n ']) {
      await signInWith(h, value);
      expect(text(h.root.querySelector('#login-message'))).toBe('El token es obligatorio');
    }
    expect(h.server.calls).toHaveLength(0);
    expect(h.storage.values.size).toBe(0);
  });

  test('a wrong token shows "Token no válido", forgets it and shows the form again (5.8)', async () => {
    const h = mountPanel();
    await h.handle.ready;
    await signInWith(h, 'x'.repeat(40));

    expect(text(h.root.querySelector('#login-message'))).toBe('Token no válido');
    expect(h.root.querySelector('form.login')).not.toBeNull();
    expect(h.storage.values.size).toBe(0);
    // No metrics and no links are shown.
    expect(h.root.querySelector('.dashboard')).toBeNull();
    expect(h.sockets).toHaveLength(0);
  });

  test('a network error says the server cannot be reached, not "Token no válido" (5.13)', async () => {
    const h = mountPanel();
    await h.handle.ready;
    h.server.fail('GET /api/admin/links', 'network');
    await signInWith(h, OWNER_TOKEN);

    expect(text(h.root.querySelector('#login-message'))).toBe(
      'No se ha podido conectar con el servidor',
    );
    expect(h.root.querySelector('form.login')).not.toBeNull();
  });

  test('a server that does not answer in 5 s is the same message (5.13)', async () => {
    const h = mountPanel();
    await h.handle.ready;
    h.server.fail('GET /api/admin/links', 'hang');

    const input = h.root.querySelector('input') as HTMLInputElement;
    input.value = OWNER_TOKEN;
    (h.root.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await settle(4900);
    expect(text(h.root.querySelector('#login-message'))).toBe('');
    await settle(200);
    expect(text(h.root.querySelector('#login-message'))).toBe(
      'No se ha podido conectar con el servidor',
    );
  });

  test('a server error (500) is also "cannot connect", not a wrong token', async () => {
    const h = mountPanel();
    await h.handle.ready;
    h.server.fail('GET /api/admin/links', 500);
    await signInWith(h, OWNER_TOKEN);
    expect(text(h.root.querySelector('#login-message'))).toBe(
      'No se ha podido conectar con el servidor',
    );
  });

  test('the button waits while the token is being checked', async () => {
    const h = mountPanel();
    await h.handle.ready;
    h.server.fail('GET /api/admin/links', 'hang');
    const input = h.root.querySelector('input') as HTMLInputElement;
    input.value = OWNER_TOKEN;
    (h.root.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await settle(100);
    const button = h.root.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(text(button)).toBe('Comprobando…');
  });
});

describe('a signed-in session', () => {
  test('cleans the token, saves it only in sessionStorage and shows the dashboard (5.1, 5.10)', async () => {
    const h = mountPanel();
    await h.handle.ready;
    await signInWith(h, `  ${OWNER_TOKEN}\n`);
    await settle();

    expect(h.root.querySelector('form.login')).toBeNull();
    expect(h.root.querySelector('.dashboard')).not.toBeNull();
    expect(h.storage.values.get(TOKEN_KEY)).toBe(OWNER_TOKEN);
  });

  test('the token travels only in the Authorization header, never in a URL or a body (5.1, 5.9)', async () => {
    const h = await mountSignedIn();
    h.sockets[0]?.open();
    await settle();

    expect(h.server.calls.length).toBeGreaterThan(3);
    for (const call of h.server.calls) {
      expect(call.path).not.toContain(OWNER_TOKEN);
      expect(call.body ?? '').not.toContain(OWNER_TOKEN);
      expect(call.headers['Authorization']).toBe(`Bearer ${OWNER_TOKEN}`);
    }
    for (const socket of h.sockets) {
      expect(socket.url).not.toContain(OWNER_TOKEN);
    }
  });

  test('the WebSocket URL carries only the ticket (5.14)', async () => {
    const h = await mountSignedIn();
    expect(h.sockets).toHaveLength(1);
    const url = new URL(h.sockets[0]?.url ?? '');
    expect([...url.searchParams.keys()]).toEqual(['ticket']);
    expect(url.searchParams.get('ticket')).toBe('ticket-1');
  });

  test('uses no cookie and no local storage (5.10)', async () => {
    window.localStorage.clear();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await mountSignedIn();
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    setItem.mockRestore();
  });

  test('a reloaded tab with a saved token goes straight to the dashboard (5.10)', async () => {
    const h = mountPanel({ savedToken: OWNER_TOKEN });
    await h.handle.ready;
    await settle();
    expect(h.root.querySelector('form.login')).toBeNull();
    expect(h.root.querySelector('.dashboard')).not.toBeNull();
  });

  test('a reloaded tab with a token the server now refuses shows "Token no válido"', async () => {
    const h = mountPanel({ savedToken: 'stale-token' });
    await h.handle.ready;
    expect(text(h.root.querySelector('#login-message'))).toBe('Token no válido');
    expect(h.storage.values.size).toBe(0);
  });

  test('a reloaded tab with the server down keeps the form and the message of a connection error', async () => {
    const h = mountPanel({
      savedToken: OWNER_TOKEN,
      configure: (server) => server.fail('GET /api/admin/links', 'network'),
    });
    await h.handle.ready;
    expect(text(h.root.querySelector('#login-message'))).toBe(
      'No se ha podido conectar con el servidor',
    );
  });
});

describe('logging out (5.11, 10.7)', () => {
  test('forgets the token, closes the connection and shows the form', async () => {
    const h = await mountSignedIn();
    h.sockets[0]?.open();
    await settle();
    expect(h.storage.values.size).toBe(1);

    const signOut = all<HTMLButtonElement>(h.root, 'button').find(
      (button) => text(button) === 'Cerrar sesión',
    );
    signOut?.click();
    await settle();

    expect(h.storage.values.size).toBe(0);
    expect(h.sockets[0]?.closed).toBe(true);
    expect(h.root.querySelector('form.login')).not.toBeNull();
    expect(h.root.querySelector('.dashboard')).toBeNull();
  });

  test('cancels the retries that were pending and hides the connection indicator', async () => {
    const h = await mountSignedIn();
    h.sockets[0]?.open();
    await settle();
    h.sockets[0]?.drop();
    expect(text(h.root.querySelector('.connection'))).toBe('Reconectando…');

    const calls = h.server.calls.length;
    all<HTMLButtonElement>(h.root, 'button')
      .find((button) => text(button) === 'Cerrar sesión')
      ?.click();
    await settle(60_000);

    expect(h.server.calls.length).toBe(calls);
    expect(h.sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('after logging out, nothing of the dashboard is left on the page', async () => {
    const h = await mountSignedIn({
      links: [
        { id: 'l1', title: 'Secreto', url: 'https://a.com', active: true, position: 0, clicks: 3 },
      ],
    });
    expect(h.root.textContent).toContain('Secreto');
    all<HTMLButtonElement>(h.root, 'button')
      .find((button) => text(button) === 'Cerrar sesión')
      ?.click();
    await settle();
    expect(h.root.textContent).not.toContain('Secreto');
  });
});

describe('a refused token in the middle of a session', () => {
  test('a 401 on a metrics refresh shows "Token no válido" and the form (10.5)', async () => {
    const h = await mountSignedIn();
    h.sockets[0]?.open();
    await settle();

    h.server.token = 'rotated-on-the-server';
    await settle(30_000); // the periodic metrics request

    expect(text(h.root.querySelector('#login-message'))).toBe('Token no válido');
    expect(h.storage.values.size).toBe(0);
    expect(h.root.querySelector('.dashboard')).toBeNull();
  });

  test('a 401 on the ticket stops the retries and shows the form (10.5)', async () => {
    const h = await mountSignedIn();
    h.sockets[0]?.open();
    await settle();
    h.sockets[0]?.drop();

    h.server.token = 'rotated-on-the-server';
    await settle(1000); // the first retry asks for a ticket

    expect(text(h.root.querySelector('#login-message'))).toBe('Token no válido');
    const calls = h.server.calls.length;
    await settle(120_000);
    expect(h.server.calls.length).toBe(calls);
  });

  test('a 401 on a link action ends the session too', async () => {
    const h = await mountSignedIn({
      links: [{ id: 'l1', title: 'A', url: 'https://a.com', active: true, position: 0, clicks: 0 }],
    });
    h.server.token = 'rotated-on-the-server';
    all<HTMLButtonElement>(h.root, 'button')
      .find((button) => (button.getAttribute('aria-label') ?? '').startsWith('Desactivar'))
      ?.click();
    await settle();
    expect(text(h.root.querySelector('#login-message'))).toBe('Token no válido');
  });
});
