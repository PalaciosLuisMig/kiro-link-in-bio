// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { API_ROUTES, type PublicLink } from '@link-in-bio/shared';

import type { FetchLike } from '../lib/api.js';
import { MESSAGES } from '../lib/messages.js';

import { startPublicPage, type PublicPageDeps } from './page.js';

// Tests of the public page with `fetch` and `navigate` injected and a DOM from
// happy-dom (task 14.6). They cover the order of the actions (the visit goes out
// once, only after a successful paint), the clicks (keepalive, same-tick
// navigation, middle button and modifiers), titles shown as text, and the
// absence of cookies and storage.
//
// Validates: Requirements 1.4, 1.5, 1.7, 1.8, 2.1 to 2.4, 3.1, 3.3 to 3.6, 11.3, 14.9.

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

const LINKS: PublicLink[] = [
  { id: ID_A, title: 'Mi web', url: 'https://ejemplo.com/a' },
  { id: ID_B, title: 'Mi canal', url: 'https://ejemplo.com/b' },
];

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

interface Harness {
  readonly container: HTMLElement;
  readonly calls: Call[];
  readonly navigated: string[];
  readonly deps: PublicPageDeps;
  /** Resolves `GET /api/links` with the given links, or fails it. */
  readonly setLinks: (result: PublicLink[] | 'error') => void;
  readonly visits: () => Call[];
  readonly clicks: () => Call[];
}

function harness(search = ''): Harness {
  document.body.innerHTML = '<main><div id="content"></div></main>';
  const container = document.getElementById('content') as HTMLElement;
  const calls: Call[] = [];
  const navigated: string[] = [];
  let links: PublicLink[] | 'error' = LINKS;

  const fetchFn: FetchLike = async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    if (path === API_ROUTES.publicLinks) {
      if (links === 'error') {
        return new Response('{}', { status: 500 });
      }
      return new Response(JSON.stringify({ links }), { status: 200 });
    }
    return new Response('{}', { status: 202 });
  };

  return {
    container,
    calls,
    navigated,
    deps: { fetch: fetchFn, navigate: (url) => navigated.push(url), search },
    setLinks: (result) => {
      links = result;
    },
    visits: () => calls.filter((call) => call.path === API_ROUTES.visits),
    clicks: () => calls.filter((call) => call.path === API_ROUTES.clicks),
  };
}

/** Dispatches a mouse event on an element and reports whether it was prevented. */
function press(
  target: Element,
  type: 'click' | 'auxclick',
  init: MouseEventInit = {},
): { defaultPrevented: boolean } {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  // happy-dom would try to navigate on an unprevented click on an anchor. This
  // listener runs after the page's own handler (it is on `document`), records
  // whether the page prevented the default, and then stops happy-dom's own.
  let defaultPrevented = false;
  const spy = (e: Event): void => {
    defaultPrevented = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener(type, spy, { once: true });
  target.dispatchEvent(event);
  document.removeEventListener(type, spy);
  return { defaultPrevented };
}

function anchors(container: HTMLElement): HTMLAnchorElement[] {
  return [...container.querySelectorAll('a')];
}

let h: Harness;

beforeEach(() => {
  h = harness('?src=instagram');
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('loading and rendering', () => {
  test('shows "Cargando enlaces…" as a status while it waits', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: PublicPageDeps = {
      ...h.deps,
      fetch: async (input, init) => {
        await gate;
        return h.deps.fetch(input, init);
      },
    };
    const started = startPublicPage(h.container, slow);

    const status = h.container.querySelector('[role="status"]');
    expect(status?.textContent).toBe(MESSAGES.loading);

    // Dashed slots reserve the place of the keys. They are decoration only: hidden
    // from assistive technology and not links, so the empty/error rules hold.
    const slots = h.container.querySelector('.placeholders');
    expect(slots?.getAttribute('aria-hidden')).toBe('true');
    expect(slots?.querySelectorAll('.placeholder')).toHaveLength(3);
    expect(h.container.querySelectorAll('a')).toHaveLength(0);

    release();
    await started;
    expect(h.container.querySelector('[role="status"]')).toBeNull();
    // The loading slots are gone once the list is there.
    expect(h.container.querySelector('.placeholders')).toBeNull();
  });

  test('renders the links in the order received, as anchors with their url', async () => {
    await startPublicPage(h.container, h.deps);
    const rendered = anchors(h.container);
    expect(rendered.map((a) => a.textContent)).toEqual(['Mi web', 'Mi canal']);
    expect(rendered.map((a) => a.getAttribute('href'))).toEqual([
      'https://ejemplo.com/a',
      'https://ejemplo.com/b',
    ]);
    expect(h.container.querySelectorAll('ul > li > a')).toHaveLength(2);
  });

  test('no active links: shows the empty message and no link element', async () => {
    h.setLinks([]);
    await startPublicPage(h.container, h.deps);
    expect(h.container.textContent).toContain(MESSAGES.empty);
    expect(h.container.querySelectorAll('a')).toHaveLength(0);
    expect(h.container.querySelectorAll('ul')).toHaveLength(0);
    expect(h.container.querySelector('.message--empty')?.textContent).toBe(MESSAGES.empty);
    expect(h.container.querySelector('.placeholders')).toBeNull();
  });

  test('an error shows the message and "Reintentar", and no link element', async () => {
    h.setLinks('error');
    await startPublicPage(h.container, h.deps);
    expect(h.container.textContent).toContain(MESSAGES.loadError);
    expect(h.container.querySelector('button')?.textContent).toBe(MESSAGES.retry);
    expect(h.container.querySelectorAll('a')).toHaveLength(0);
  });

  test('a list that does not arrive in 5 s is an error', async () => {
    vi.useFakeTimers();
    const never: PublicPageDeps = { ...h.deps, fetch: () => new Promise<Response>(() => {}) };
    const started = startPublicPage(h.container, never);
    await vi.advanceTimersByTimeAsync(5000);
    await started;
    expect(h.container.textContent).toContain(MESSAGES.loadError);
  });

  test('never sends an owner token', async () => {
    await startPublicPage(h.container, h.deps);
    press(anchors(h.container)[0] as HTMLAnchorElement, 'click');
    for (const call of h.calls) {
      const headers = JSON.stringify(call.init?.headers ?? {}).toLowerCase();
      expect(headers).not.toContain('authorization');
    }
  });

  test('a title with HTML is shown as text and creates no element', async () => {
    h.setLinks([
      { id: ID_A, title: '<script>window.__pwned = 1</script>', url: 'https://ejemplo.com' },
      { id: ID_B, title: '<b>negrita</b>', url: 'https://ejemplo.com' },
    ]);
    await startPublicPage(h.container, h.deps);
    expect(h.container.querySelectorAll('script, b')).toHaveLength(0);
    expect(anchors(h.container).map((a) => a.textContent)).toEqual([
      '<script>window.__pwned = 1</script>',
      '<b>negrita</b>',
    ]);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('visit', () => {
  test('is sent once, after the list is painted, with the channel', async () => {
    await startPublicPage(h.container, h.deps);
    expect(h.visits()).toHaveLength(1);
    expect(h.visits()[0]?.init?.body).toBe('{"channel":"instagram"}');
    // The list is already on screen: the visit does not delay it.
    expect(anchors(h.container)).toHaveLength(2);
  });

  test('is sent without a channel when `src` is absent', async () => {
    const plain = harness('');
    await startPublicPage(plain.container, plain.deps);
    expect(plain.visits()[0]?.init?.body).toBe('{}');
  });

  test('is sent also when the list is empty', async () => {
    h.setLinks([]);
    await startPublicPage(h.container, h.deps);
    expect(h.visits()).toHaveLength(1);
  });

  test('is not sent when the list fails', async () => {
    h.setLinks('error');
    await startPublicPage(h.container, h.deps);
    expect(h.visits()).toHaveLength(0);
  });

  test('"Reintentar" shows the loading state, loads again and sends the visit once', async () => {
    h.setLinks('error');
    await startPublicPage(h.container, h.deps);
    expect(h.visits()).toHaveLength(0);

    h.setLinks(LINKS);
    const retry = h.container.querySelector('button') as HTMLButtonElement;
    retry.click();
    // The error is hidden and the loading state shown right away.
    expect(h.container.querySelector('[role="alert"]')).toBeNull();
    expect(h.container.querySelector('[role="status"]')?.textContent).toBe(MESSAGES.loading);

    await vi.waitFor(() => expect(anchors(h.container)).toHaveLength(2));
    expect(h.visits()).toHaveLength(1);
  });

  test('a second failure after a success-less retry still sends no visit', async () => {
    h.setLinks('error');
    await startPublicPage(h.container, h.deps);
    (h.container.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.container.querySelector('button')).not.toBeNull());
    expect(h.visits()).toHaveLength(0);
  });

  test('a failing visit changes nothing on the page and is not retried', async () => {
    const failing: PublicPageDeps = {
      ...h.deps,
      fetch: async (input, init) => {
        if (String(input) === API_ROUTES.visits) {
          h.calls.push({ path: String(input), init });
          throw new TypeError('offline');
        }
        return h.deps.fetch(input, init);
      },
    };
    await startPublicPage(h.container, failing);
    await Promise.resolve();
    expect(anchors(h.container)).toHaveLength(2);
    expect(h.container.textContent).not.toContain(MESSAGES.loadError);
    expect(h.visits()).toHaveLength(1);
  });

  test('restoring the page from the back/forward cache sends no new visit', async () => {
    await startPublicPage(h.container, h.deps);
    window.dispatchEvent(new Event('pageshow'));
    expect(h.visits()).toHaveLength(1);
  });
});

describe('clicks', () => {
  async function ready(): Promise<HTMLAnchorElement> {
    await startPublicPage(h.container, h.deps);
    return anchors(h.container)[0] as HTMLAnchorElement;
  }

  test('a primary click sends one keepalive request and navigates in the same tick', async () => {
    const link = await ready();
    const { defaultPrevented } = press(link, 'click', { button: 0 });

    expect(defaultPrevented).toBe(true);
    // Synchronous: no await between the click and these assertions.
    expect(h.navigated).toEqual(['https://ejemplo.com/a']);
    expect(h.clicks()).toHaveLength(1);
    expect(h.clicks()[0]?.init).toMatchObject({ method: 'POST', keepalive: true });
    expect(h.clicks()[0]?.init?.body).toBe(`{"linkId":"${ID_A}","channel":"instagram"}`);
  });

  test('navigates in the same tick even if the click request never resolves', async () => {
    const stuck: PublicPageDeps = {
      ...h.deps,
      fetch: (input, init) =>
        String(input) === API_ROUTES.clicks
          ? new Promise<Response>(() => {})
          : h.deps.fetch(input, init),
    };
    await startPublicPage(h.container, stuck);
    press(anchors(h.container)[0] as HTMLAnchorElement, 'click', { button: 0 });
    expect(h.navigated).toEqual(['https://ejemplo.com/a']);
  });

  test('navigates also when the click request fails, with no message', async () => {
    const failing: PublicPageDeps = {
      ...h.deps,
      fetch: async (input, init) => {
        if (String(input) === API_ROUTES.clicks) {
          throw new TypeError('offline');
        }
        return h.deps.fetch(input, init);
      },
    };
    await startPublicPage(h.container, failing);
    press(anchors(h.container)[0] as HTMLAnchorElement, 'click', { button: 0 });
    await Promise.resolve();
    expect(h.navigated).toEqual(['https://ejemplo.com/a']);
    expect(h.container.textContent).not.toContain(MESSAGES.loadError);
  });

  test('the middle button counts the click and leaves the new tab to the browser', async () => {
    const link = await ready();
    const { defaultPrevented } = press(link, 'auxclick', { button: 1 });
    expect(defaultPrevented).toBe(false);
    expect(h.navigated).toEqual([]);
    expect(h.clicks()).toHaveLength(1);
  });

  test.each([
    ['ctrl', { ctrlKey: true }],
    ['cmd', { metaKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
  ])('%s + click counts the click and does not prevent the default', async (_name, init) => {
    const link = await ready();
    const { defaultPrevented } = press(link, 'click', { button: 0, ...init });
    expect(defaultPrevented).toBe(false);
    expect(h.navigated).toEqual([]);
    expect(h.clicks()).toHaveLength(1);
  });

  test('other buttons of `auxclick` (right button) are not counted', async () => {
    const link = await ready();
    press(link, 'auxclick', { button: 2 });
    expect(h.clicks()).toHaveLength(0);
  });

  test('each activation sends exactly one request', async () => {
    const link = await ready();
    press(link, 'click', { button: 0 });
    press(link, 'auxclick', { button: 1 });
    press(link, 'click', { button: 0, ctrlKey: true });
    expect(h.clicks()).toHaveLength(3);
  });

  test('clicks on the second link send its own id', async () => {
    await startPublicPage(h.container, h.deps);
    press(anchors(h.container)[1] as HTMLAnchorElement, 'click', { button: 0 });
    expect(h.clicks()[0]?.init?.body).toContain(ID_B);
  });

  test('a click outside the links does nothing', async () => {
    await startPublicPage(h.container, h.deps);
    press(h.container, 'click', { button: 0 });
    expect(h.clicks()).toHaveLength(0);
    expect(h.navigated).toEqual([]);
  });

  test('the visit and every click of a page load share the same channel', async () => {
    const link = await ready();
    press(link, 'click', { button: 0 });
    const channels = [...h.visits(), ...h.clicks()].map(
      (call) => (JSON.parse(String(call.init?.body)) as { channel?: string }).channel,
    );
    expect(channels).toEqual(['instagram', 'instagram']);
  });

  test('keeps working after "Reintentar" renders the list again', async () => {
    h.setLinks('error');
    await startPublicPage(h.container, h.deps);
    h.setLinks(LINKS);
    (h.container.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(anchors(h.container)).toHaveLength(2));
    press(anchors(h.container)[0] as HTMLAnchorElement, 'click', { button: 0 });
    expect(h.navigated).toEqual(['https://ejemplo.com/a']);
    expect(h.clicks()).toHaveLength(1);
  });
});

describe('privacy', () => {
  test('uses no cookies and writes no local or session storage', async () => {
    // Start empty and watch the writes themselves: a length compared with a baseline
    // would miss a write to a key that already existed.
    window.localStorage.clear();
    window.sessionStorage.clear();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    await startPublicPage(h.container, h.deps);
    press(anchors(h.container)[0] as HTMLAnchorElement, 'click', { button: 0 });

    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe('');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    setItem.mockRestore();
  });

  test('only talks to the API paths of its own origin', async () => {
    await startPublicPage(h.container, h.deps);
    press(anchors(h.container)[0] as HTMLAnchorElement, 'click', { button: 0 });
    for (const call of h.calls) {
      expect(call.path.startsWith('/api/')).toBe(true);
    }
  });
});
