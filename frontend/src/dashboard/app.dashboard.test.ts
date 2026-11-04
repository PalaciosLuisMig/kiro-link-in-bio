// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  serialize,
  snapshotMessage,
  type ActivityEvent,
  type MetricsSnapshot,
} from '@link-in-bio/shared';

import { emptySnapshot, link } from './testing/fake-server.js';
import {
  all,
  buttonNamed,
  mountSignedIn,
  NOW,
  settle,
  startClock,
  text,
  type PanelHarness,
} from './testing/panel-harness.js';

// Tests of the running Panel through the whole app (tasks 15.10, 15.11, 15.12):
// what the metrics show, how live messages change it, the management of links, the
// confirmations and the reset.
//
// Validates: Requirements 6.9 to 6.16, 7, 8, 9, 15.1, 15.2, 16.

beforeEach(() => {
  startClock();
});

afterEach(() => {
  vi.useRealTimers();
});

const iso = (offsetMs = 0): string => new Date(NOW.getTime() + offsetMs).toISOString();

const event = (
  id: string,
  type: 'click' | 'visit',
  channel: string,
  offsetMs: number,
  title?: string,
): ActivityEvent => ({ id, type, channel, at: iso(offsetMs), ...(title ? { title } : {}) });

/** Sends a live message through the first socket, as the server would. */
function live(h: PanelHarness, snapshot: MetricsSnapshot): void {
  h.sockets[0]?.receive(serialize(snapshotMessage(snapshot)));
}

const bars = (h: PanelHarness) => all(h.root, 'svg.chart rect.bar');
const rows = (h: PanelHarness) => all(h.root, '.link-row');
const rowTitles = (h: PanelHarness) => rows(h).map((row) => text(row.querySelector('.link-title')));
const feedTexts = (h: PanelHarness) => all(h.root, '.feed-item').map((item) => text(item));

describe('what the metrics show', () => {
  test('the page has two independent columns: metrics and activity on one, the links on the other', async () => {
    const h = await mountSignedIn();
    const columns = all(h.root, '.panel-col');
    expect(columns).toHaveLength(2);
    const names = (column: Element | undefined): string[] =>
      all(column as Element, ':scope > section').map(
        (section) => (section.className.match(/panel-section--(\w+)/) ?? [])[1] ?? '',
      );
    expect(names(columns[0])).toEqual(['totals', 'chart', 'channels', 'feed']);
    expect(names(columns[1])).toEqual(['links']);
  });

  test('totals at 0 when nothing has been recorded (7.2)', async () => {
    const h = await mountSignedIn();
    expect(text(h.root.querySelector('[data-total="clicks"]'))).toBe('0');
    expect(text(h.root.querySelector('[data-total="visits"]'))).toBe('0');
  });

  test('the totals, as received', async () => {
    const h = await mountSignedIn({
      snapshot: emptySnapshot({ totals: { clicks: 41, visits: 17 } }),
    });
    expect(text(h.root.querySelector('[data-total="clicks"]'))).toBe('41');
    expect(text(h.root.querySelector('[data-total="visits"]'))).toBe('17');
  });

  test('every link, active or not, with its clicks and 0 when it has none (7.1)', async () => {
    const h = await mountSignedIn({
      links: [link(1), link(2, { active: false }), link(3)],
      snapshot: emptySnapshot({ links: { 'link-1': 12, 'link-3': 4 } }),
    });
    expect(rowTitles(h)).toEqual(['Enlace 1', 'Enlace 2', 'Enlace 3']);
    expect(rows(h).map((row) => text(row.querySelector('.link-clicks strong')))).toEqual([
      '12',
      '0',
      '4',
    ]);
    expect(rows(h).map((row) => text(row.querySelector('.link-state')))).toEqual([
      'Activo',
      'Inactivo',
      'Activo',
    ]);
  });

  test('without links, a message instead of the list (7.10)', async () => {
    const h = await mountSignedIn();
    expect(text(h.root.querySelector('.links-list'))).toBe('Todavía no has creado ningún enlace');
    expect(rows(h)).toHaveLength(0);
  });

  test('titles and urls are shown as text and create no element (14.9)', async () => {
    const h = await mountSignedIn({
      links: [link(1, { title: '<img src=x onerror=alert(1)>', url: 'https://a.com/<b>' })],
      snapshot: emptySnapshot({
        events: [event('e1', 'click', 'qr', 0, '<script>alert(1)</script>')],
      }),
    });
    expect(h.root.querySelectorAll('img, script, b').length).toBe(0);
    expect(text(h.root.querySelector('.link-title'))).toBe('<img src=x onerror=alert(1)>');
    expect(text(h.root.querySelector('.feed-title'))).toBe('<script>alert(1)</script>');
  });

  test('a failed metrics request shows the error and "Reintentar", and no numbers (7.8)', async () => {
    const h = await mountSignedIn({
      configure: (server) => server.fail('GET /api/admin/metrics', 500),
      links: [link(1)],
      snapshot: emptySnapshot({ totals: { clicks: 99, visits: 99 } }),
    });
    // The metrics were asked right after the sign-in and failed.
    expect(text(h.root.querySelector('.metrics-status'))).toContain(
      'No se han podido cargar las métricas',
    );
    expect(buttonNamed(h.root, 'Reintentar')).toBeDefined();
    expect(h.root.querySelector('[data-total]')).toBeNull();
    expect(h.root.querySelector('svg.chart')).toBeNull();
    expect(h.root.textContent).not.toContain('99');
    // The sections of numbers are hidden too, so no heading is left over an empty body.
    for (const name of ['totals', 'chart', 'channels', 'feed']) {
      expect(h.root.querySelector(`.panel-section--${name}`)?.hasAttribute('hidden')).toBe(true);
    }
  });

  test('"Reintentar" asks again and replaces the error with the metrics (7.9)', async () => {
    const h = await mountSignedIn({
      configure: (server) => server.fail('GET /api/admin/metrics', 'network'),
      snapshot: emptySnapshot({ totals: { clicks: 7, visits: 3 } }),
    });
    expect(h.root.querySelector('[data-total]')).toBeNull();

    buttonNamed(h.root, 'Reintentar').click();
    await settle();

    expect(text(h.root.querySelector('[data-total="clicks"]'))).toBe('7');
    expect(text(h.root.querySelector('.metrics-status'))).toBe('');
  });

  test('a metrics request that does not answer in 5 s is the same error', async () => {
    const h = await mountSignedIn({
      configure: (server) => server.fail('GET /api/admin/metrics', 'hang'),
    });
    expect(text(h.root.querySelector('.metrics-status'))).toContain('Cargando métricas');
    await settle(5000);
    expect(text(h.root.querySelector('.metrics-status'))).toContain(
      'No se han podido cargar las métricas',
    );
  });

  test('a metrics answer that is not valid is a failed load, not partial numbers', async () => {
    const h = await mountSignedIn({
      configure: (server) => {
        const real = server.fetch;
        (server as { fetch: typeof real }).fetch = async (input, init) =>
          String(input) === '/api/admin/metrics' && !(init?.method ?? 'GET').includes('POST')
            ? new Response(JSON.stringify({ totals: { clicks: 5 } }), { status: 200 })
            : real(input, init);
      },
    });
    expect(h.root.querySelector('[data-total]')).toBeNull();
    expect(text(h.root.querySelector('.metrics-status'))).toContain(
      'No se han podido cargar las métricas',
    );
  });
});

describe('the chart (7.3, 15.2)', () => {
  test('has exactly 60 bars, in an image with a text summary', async () => {
    const h = await mountSignedIn();
    expect(bars(h)).toHaveLength(60);
    const svg = h.root.querySelector('svg.chart') as SVGElement;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toContain('todavía no hay clics');
  });

  test('has a table with the 60 minutes and their start time, readable as text (15.2)', async () => {
    const minuteStart = Math.floor(NOW.getTime() / 60_000) * 60_000;
    const h = await mountSignedIn({
      snapshot: emptySnapshot({
        totals: { clicks: 8, visits: 0 },
        minutes: {
          [new Date(minuteStart).toISOString()]: 5,
          [new Date(minuteStart - 60_000).toISOString()]: 3,
        },
      }),
    });
    const table = h.root.querySelector('table.visually-hidden') as HTMLTableElement;
    expect(text(table.querySelector('caption'))).toBe(
      'Clics en cada uno de los últimos 60 minutos',
    );
    const body = all(table, 'tbody tr');
    expect(body).toHaveLength(60);
    // The minutes are consecutive and end at the current one, as HH:MM in the given zone.
    expect(text(body[59]?.querySelector('th'))).toBe('12:00');
    expect(text(body[59]?.querySelector('td'))).toBe('5');
    expect(text(body[58]?.querySelector('th'))).toBe('11:59');
    expect(text(body[58]?.querySelector('td'))).toBe('3');
    expect(text(body[0]?.querySelector('th'))).toBe('11:01');
    expect(text(body[0]?.querySelector('td'))).toBe('0');

    expect(h.root.querySelector('svg.chart')?.getAttribute('aria-label')).toContain(
      '8 en total, con un máximo de 5 a las 12:00',
    );
  });

  test('the table is hidden visually but not with display:none, which would hide it from a screen reader', () => {
    // Checked on the class: the style test verifies the CSS behind it.
    return mountSignedIn().then((h) => {
      const table = h.root.querySelector('table');
      expect(table?.className).toContain('visually-hidden');
      expect(table?.hasAttribute('hidden')).toBe(false);
      expect(table?.getAttribute('aria-hidden')).toBeNull();
    });
  });

  test('uses attributes and no inline style on the bars (the CSP forbids inline styles)', async () => {
    const h = await mountSignedIn({
      snapshot: emptySnapshot({
        minutes: { [new Date(Math.floor(NOW.getTime() / 60_000) * 60_000).toISOString()]: 4 },
      }),
    });
    expect(h.root.querySelectorAll('[style]')).toHaveLength(0);
    const tallest = bars(h).at(-1);
    expect(Number(tallest?.getAttribute('height'))).toBeGreaterThan(0);
  });

  test('a new minute adds a bar at 0 and drops the oldest, with no reload (8.4)', async () => {
    const h = await mountSignedIn({ snapshot: emptySnapshot() });
    const legend = (): string[] => all(h.root, '.chart-legend span').map((span) => text(span));
    expect(legend()).toEqual(['11:01', '12:00']);

    await settle(60_000);
    expect(legend()).toEqual(['11:02', '12:01']);
    expect(bars(h)).toHaveLength(60);
    await settle(60_000);
    expect(legend()).toEqual(['11:03', '12:02']);
  });
});

describe('channels (7.4)', () => {
  test('only channels with activity, most clicks first and then by name', async () => {
    const h = await mountSignedIn({
      snapshot: emptySnapshot({
        channels: {
          qr: { clicks: 5, visits: 9 },
          github: { clicks: 5, visits: 1 },
          instagram: { clicks: 12, visits: 0 },
          otro: { clicks: 0, visits: 0 },
        },
      }),
    });
    const names = all(h.root, '[data-channel]').map((row) => row.getAttribute('data-channel'));
    expect(names).toEqual(['instagram', 'github', 'qr']);
    const first = all(h.root, '[data-channel]')[0] as HTMLElement;
    expect(all(first, 'td').map((cell) => text(cell))).toEqual(['12', '0']);
  });

  test('a message when there is no activity yet', async () => {
    const h = await mountSignedIn();
    expect(text(h.root.querySelector('.panel-section--channels'))).toContain(
      'Todavía no hay canales con actividad',
    );
  });
});

describe('the activity feed (7.5, 9.5, 9.6)', () => {
  test('without events, a message', async () => {
    const h = await mountSignedIn();
    expect(text(h.root.querySelector('.panel-section--feed'))).toContain(
      'Todavía no hay actividad',
    );
  });

  test('each entry: HH:MM:SS, the type in Spanish, the title only for a click, the channel', async () => {
    const h = await mountSignedIn({
      snapshot: emptySnapshot({
        events: [
          event('e2', 'click', 'instagram', -5000, 'Mi web'),
          event('e1', 'visit', 'qr', -65_000),
        ],
      }),
    });
    const items = all(h.root, '.feed-item');
    expect(items).toHaveLength(2);

    expect(text(items[0]?.querySelector('.feed-time'))).toBe('11:59:55');
    expect(text(items[0]?.querySelector('.feed-kind'))).toBe('Clic');
    expect(text(items[0]?.querySelector('.feed-title'))).toBe('Mi web');
    expect(text(items[0]?.querySelector('.feed-channel'))).toBe('instagram');

    expect(text(items[1]?.querySelector('.feed-time'))).toBe('11:58:55');
    expect(text(items[1]?.querySelector('.feed-kind'))).toBe('Visita');
    expect(items[1]?.querySelector('.feed-title')).toBeNull();
    expect(text(items[1]?.querySelector('.feed-channel'))).toBe('qr');
  });

  test('never more than 20 entries', async () => {
    const events = Array.from({ length: 25 }, (_unused, n) =>
      event(`e${String(n).padStart(2, '0')}`, 'visit', 'qr', -n * 1000),
    );
    const h = await mountSignedIn({ snapshot: emptySnapshot({ events }) });
    expect(all(h.root, '.feed-item')).toHaveLength(20);
  });
});

describe('live messages (8.3, 8.5, 8.6, 16.6)', () => {
  test('update the counters, the channels and the feed without reloading', async () => {
    const h = await mountSignedIn({ links: [link(1)] });
    h.sockets[0]?.open();
    await settle();

    live(
      h,
      emptySnapshot({
        totals: { clicks: 3, visits: 2 },
        links: { 'link-1': 3 },
        channels: { qr: { clicks: 3, visits: 2 } },
        events: [event('c1', 'click', 'qr', 0, 'Enlace 1')],
      }),
    );

    expect(text(h.root.querySelector('[data-total="clicks"]'))).toBe('3');
    expect(text(h.root.querySelector('[data-total="visits"]'))).toBe('2');
    expect(text(h.root.querySelector('.link-clicks strong'))).toBe('3');
    expect(all(h.root, '[data-channel]')).toHaveLength(1);
    expect(feedTexts(h)[0]).toContain('Enlace 1');
  });

  test('keep the channels in order as they change (8.3)', async () => {
    const h = await mountSignedIn({
      snapshot: emptySnapshot({
        channels: { qr: { clicks: 10, visits: 0 }, github: { clicks: 1, visits: 0 } },
      }),
    });
    h.sockets[0]?.open();
    live(h, emptySnapshot({ channels: { github: { clicks: 20, visits: 0 } } }));
    const names = all(h.root, '[data-channel]').map((row) => row.getAttribute('data-channel'));
    expect(names).toEqual(['github', 'qr']);
  });

  test('a smaller value never lowers what is shown; the rest is applied (8.5)', async () => {
    const h = await mountSignedIn({
      snapshot: emptySnapshot({ totals: { clicks: 50, visits: 10 } }),
    });
    h.sockets[0]?.open();
    live(h, emptySnapshot({ totals: { clicks: 20, visits: 30 } }));
    expect(text(h.root.querySelector('[data-total="clicks"]'))).toBe('50');
    expect(text(h.root.querySelector('[data-total="visits"]'))).toBe('30');
  });

  test('a message that breaks the contract is dropped and the connection stays (8.6)', async () => {
    const h = await mountSignedIn({
      snapshot: emptySnapshot({ totals: { clicks: 5, visits: 5 } }),
    });
    h.sockets[0]?.open();
    h.sockets[0]?.receive('not json');
    h.sockets[0]?.receive(JSON.stringify({ type: 'snapshot', epoch: 'x' }));
    expect(text(h.root.querySelector('[data-total="clicks"]'))).toBe('5');
    expect(h.sockets[0]?.closed).toBe(false);
  });

  test('a message of an older epoch is dropped whole (8.6)', async () => {
    const h = await mountSignedIn({
      snapshot: emptySnapshot({ epoch: 5000, totals: { clicks: 5, visits: 5 } }),
    });
    h.sockets[0]?.open();
    live(h, emptySnapshot({ epoch: 4000, totals: { clicks: 999, visits: 999 } }));
    expect(text(h.root.querySelector('[data-total="clicks"]'))).toBe('5');
  });

  test('a newer epoch (a reset) clears the counters and the feed before applying (16.6)', async () => {
    const h = await mountSignedIn({
      links: [link(1)],
      snapshot: emptySnapshot({
        epoch: 1000,
        totals: { clicks: 40, visits: 8 },
        links: { 'link-1': 40 },
        channels: { qr: { clicks: 40, visits: 8 } },
        events: [event('old', 'click', 'qr', 0, 'Enlace 1')],
      }),
    });
    h.sockets[0]?.open();
    live(h, emptySnapshot({ epoch: 9000 }));

    expect(text(h.root.querySelector('[data-total="clicks"]'))).toBe('0');
    expect(text(h.root.querySelector('[data-total="visits"]'))).toBe('0');
    expect(text(h.root.querySelector('.link-clicks strong'))).toBe('0');
    expect(all(h.root, '[data-channel]')).toHaveLength(0);
    expect(all(h.root, '.feed-item')).toHaveLength(0);
  });
});

describe('the connection indicator (10.2)', () => {
  test('"Conectando…" first, nothing when open, "Reconectando…" after a drop, in a polite live region', async () => {
    const h = await mountSignedIn();
    const indicator = h.root.querySelector('.connection') as HTMLElement;
    expect(indicator.getAttribute('aria-live')).toBe('polite');
    expect(text(indicator)).toBe('Conectando…');

    h.sockets[0]?.open();
    expect(text(indicator)).toBe('');
    h.sockets[0]?.drop();
    expect(text(indicator)).toBe('Reconectando…');

    await settle(1000);
    h.sockets[1]?.open();
    expect(text(indicator)).toBe('');
  });
});

describe('a link the Panel does not show (8.11)', () => {
  test('asks for the links and the metrics again, at most once every 5 s', async () => {
    const h = await mountSignedIn({ links: [link(1)] });
    h.sockets[0]?.open();
    await settle();
    const linkCalls = () => h.server.callsTo('GET', '/api/admin/links').length;
    const metricCalls = () => h.server.callsTo('GET', '/api/admin/metrics').length;
    const before = { links: linkCalls(), metrics: metricCalls() };

    live(h, emptySnapshot({ links: { 'link-1': 1, 'created-elsewhere': 2 } }));
    await settle();
    expect(linkCalls()).toBe(before.links + 1);
    expect(metricCalls()).toBe(before.metrics + 1);

    // Inside the 5 s: no new request, however many messages arrive.
    h.server.links = [link(1), link(7, { id: 'created-elsewhere' })];
    live(h, emptySnapshot({ links: { 'link-1': 1, 'created-elsewhere': 3 } }));
    await settle(1000);
    expect(linkCalls()).toBe(before.links + 1);
  });

  test('different unknown links in a row: only one refetch every 5 s (8.11)', async () => {
    const h = await mountSignedIn({ links: [link(1)] });
    h.sockets[0]?.open();
    await settle();
    const linkCalls = () => h.server.callsTo('GET', '/api/admin/links').length;
    const before = linkCalls();

    live(h, emptySnapshot({ links: { 'link-1': 1, 'ghost-a': 1 } }));
    await settle(100);
    expect(linkCalls()).toBe(before + 1);

    // A NEW unknown id arrives 1 s later: it is not ignored yet, but the 5 s limit holds.
    await settle(900);
    live(h, emptySnapshot({ links: { 'link-1': 2, 'ghost-b': 1 } }));
    await settle(100);
    expect(linkCalls()).toBe(before + 1);

    // Once 5 s have passed since the last refetch, the next unknown id asks again.
    await settle(5000);
    live(h, emptySnapshot({ links: { 'link-1': 3, 'ghost-b': 2 } }));
    await settle(100);
    expect(linkCalls()).toBe(before + 2);
  });

  test('the new link appears after the refetch', async () => {
    const h = await mountSignedIn({ links: [link(1)] });
    h.sockets[0]?.open();
    await settle();
    h.server.links = [link(1), link(2)];
    live(h, emptySnapshot({ links: { 'link-1': 1, 'link-2': 4 } }));
    await settle();
    expect(rowTitles(h)).toEqual(['Enlace 1', 'Enlace 2']);
  });

  test('an id that is still unknown after refetching is ignored from then on', async () => {
    const h = await mountSignedIn({ links: [link(1)] });
    h.sockets[0]?.open();
    await settle();
    const linkCalls = () => h.server.callsTo('GET', '/api/admin/links').length;

    live(h, emptySnapshot({ links: { 'link-1': 1, ghost: 9 } }));
    await settle();
    const after = linkCalls();

    await settle(10_000);
    live(h, emptySnapshot({ links: { 'link-1': 2, ghost: 10 } }));
    await settle();
    expect(linkCalls()).toBe(after);
    expect(rowTitles(h)).toEqual(['Enlace 1']);
  });
});

describe('the announcer (9.4)', () => {
  const announcer = (h: PanelHarness): string => text(h.root.querySelector('[data-announcer]'));

  test('is a polite live region, and says nothing about the first load of the feed', async () => {
    const h = await mountSignedIn({
      snapshot: emptySnapshot({
        events: [event('a', 'visit', 'qr', 0), event('b', 'visit', 'qr', -1000)],
      }),
    });
    expect(h.root.querySelector('[data-announcer]')?.getAttribute('aria-live')).toBe('polite');
    expect(announcer(h)).toBe('');
  });

  test('summarizes the new events, at most one summary every 10 s', async () => {
    const h = await mountSignedIn();
    h.sockets[0]?.open();
    await settle();

    live(
      h,
      emptySnapshot({
        events: [
          event('n1', 'visit', 'qr', 0),
          event('n2', 'click', 'qr', 0, 'A'),
          event('n3', 'visit', 'qr', 0),
        ],
      }),
    );
    expect(announcer(h)).toBe('3 eventos nuevos');

    await settle(3000);
    live(h, emptySnapshot({ events: [event('n4', 'visit', 'qr', 3000)] }));
    live(h, emptySnapshot({ events: [event('n5', 'visit', 'qr', 3500)] }));
    // Inside the 10 s: still the first summary.
    expect(announcer(h)).toBe('3 eventos nuevos');

    await settle(10_000);
    expect(announcer(h)).toBe('2 eventos nuevos');
  });
});

describe('managing links (6, 15.1)', () => {
  test('every control is a real button reachable with the keyboard', async () => {
    const h = await mountSignedIn({ links: [link(1), link(2)] });
    const buttons = all<HTMLButtonElement>(h.root, 'button');
    expect(buttons.length).toBeGreaterThan(8);
    for (const button of buttons) {
      expect(button.type === 'button' || button.type === 'submit').toBe(true);
      expect(button.getAttribute('tabindex')).not.toBe('-1');
    }
    // Reordering needs no dragging: there are explicit up and down buttons.
    expect(buttonNamed(h.root, 'Subir «Enlace 2»')).toBeDefined();
    expect(buttonNamed(h.root, 'Bajar «Enlace 1»')).toBeDefined();
  });

  test('each button names the link it acts on', async () => {
    const h = await mountSignedIn({ links: [link(1, { title: 'Mi blog' })] });
    const names = all<HTMLButtonElement>(h.root, '.link-actions button').map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(names).toEqual([
      'Subir «Mi blog»',
      'Bajar «Mi blog»',
      'Editar «Mi blog»',
      'Desactivar «Mi blog»',
      'Eliminar «Mi blog»',
    ]);
  });

  describe('creating', () => {
    const fill = (h: PanelHarness, title: string, url: string): void => {
      (h.root.querySelector('#new-link-title') as HTMLInputElement).value = title;
      (h.root.querySelector('#new-link-url') as HTMLInputElement).value = url;
      (h.root.querySelector('form.add-form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    };

    test('sends the title and the url and shows the updated list, with no reload (6.14)', async () => {
      const h = await mountSignedIn({ links: [link(1)] });
      fill(h, '  Nuevo  ', 'https://nuevo.com');
      await settle();

      const post = h.server.callsTo('POST', '/api/admin/links')[0];
      expect(JSON.parse(post?.body ?? '{}')).toEqual({
        title: '  Nuevo  ',
        url: 'https://nuevo.com',
      });
      expect(rowTitles(h)).toEqual(['Enlace 1', 'Nuevo']);
      expect((h.root.querySelector('#new-link-title') as HTMLInputElement).value).toBe('');
    });

    test('with 10 links the form is disabled and says why (6.10)', async () => {
      const h = await mountSignedIn({ links: Array.from({ length: 10 }, (_u, n) => link(n + 1)) });
      expect(text(h.root.querySelector('#links-limit'))).toBe(
        'Has alcanzado el máximo de 10 enlaces',
      );
      expect(h.root.querySelector('#links-limit')?.hasAttribute('hidden')).toBe(false);
      expect((h.root.querySelector('.add-form button') as HTMLButtonElement).disabled).toBe(true);
      expect((h.root.querySelector('#new-link-title') as HTMLInputElement).disabled).toBe(true);

      fill(h, 'Otro', 'https://otro.com');
      await settle();
      expect(h.server.callsTo('POST', '/api/admin/links')).toHaveLength(0);
    });

    test('with fewer than 10 the limit message is hidden', async () => {
      const h = await mountSignedIn({ links: [link(1)] });
      expect(h.root.querySelector('#links-limit')?.hasAttribute('hidden')).toBe(true);
    });

    describe('validation before sending', () => {
      const addButton = (h: PanelHarness): HTMLButtonElement =>
        h.root.querySelector('.add-form button') as HTMLButtonElement;
      const type = (h: PanelHarness, id: string, value: string): void => {
        const input = h.root.querySelector(id) as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const hint = (h: PanelHarness): Element | null => h.root.querySelector('#new-link-url-hint');

      test('the button is disabled until both fields are filled', async () => {
        const h = await mountSignedIn({ links: [link(1)] });
        expect(addButton(h).disabled).toBe(true);
        type(h, '#new-link-title', 'Mi blog');
        expect(addButton(h).disabled).toBe(true);
        type(h, '#new-link-url', 'https://blog.com');
        expect(addButton(h).disabled).toBe(false);
        type(h, '#new-link-title', '   ');
        expect(addButton(h).disabled).toBe(true);
      });

      test.each(['http://blog.com', 'blog.com', 'ftp://blog.com', 'https://', 'https:///x'])(
        'a URL that is not https:// (%s) keeps the button disabled and sends nothing',
        async (url) => {
          const h = await mountSignedIn({ links: [link(1)] });
          type(h, '#new-link-title', 'Mi blog');
          type(h, '#new-link-url', url);
          expect(addButton(h).disabled).toBe(true);
          fill(h, 'Mi blog', url);
          await settle();
          expect(h.server.callsTo('POST', '/api/admin/links')).toHaveLength(0);
          expect(rowTitles(h)).toEqual(['Enlace 1']);
        },
      );

      test('says the URL must start with https:// only when the URL is wrong', async () => {
        const h = await mountSignedIn({ links: [link(1)] });
        expect(hint(h)?.hasAttribute('hidden')).toBe(true);
        type(h, '#new-link-url', 'http://blog.com');
        expect(hint(h)?.hasAttribute('hidden')).toBe(false);
        expect(text(hint(h))).toBe('La URL debe empezar por https://');
        expect(h.root.querySelector('#new-link-url')?.getAttribute('aria-invalid')).toBe('true');
        expect(h.root.querySelector('#new-link-url')?.getAttribute('aria-describedby')).toBe(
          'new-link-url-hint',
        );
        type(h, '#new-link-url', 'https://blog.com');
        expect(hint(h)?.hasAttribute('hidden')).toBe(true);
        type(h, '#new-link-url', '');
        expect(hint(h)?.hasAttribute('hidden')).toBe(true);
      });

      test('the button waits again after a link is created', async () => {
        const h = await mountSignedIn({ links: [link(1)] });
        type(h, '#new-link-title', 'Nuevo');
        type(h, '#new-link-url', 'https://nuevo.com');
        (h.root.querySelector('form.add-form') as HTMLFormElement).dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
        await settle();
        expect(rowTitles(h)).toEqual(['Enlace 1', 'Nuevo']);
        expect(addButton(h).disabled).toBe(true);
      });

      test('when editing, Save also needs a title and an https:// URL', async () => {
        const h = await mountSignedIn({ links: [link(1)] });
        (h.root.querySelector('.js-edit') as HTMLButtonElement).click();
        const save = h.root.querySelector('.edit-form button[type="submit"]') as HTMLButtonElement;
        const url = h.root.querySelector('#edit-url-' + link(1).id) as HTMLInputElement;
        expect(save.disabled).toBe(false);
        url.value = 'http://viejo.com';
        url.dispatchEvent(new Event('input', { bubbles: true }));
        expect(save.disabled).toBe(true);
        (h.root.querySelector('.edit-form') as HTMLFormElement).dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
        await settle();
        expect(h.server.callsTo('PATCH', '/api/admin/links/' + link(1).id)).toHaveLength(0);
      });
    });

    test('the server says the limit was reached: a notice and a fresh list (6.9)', async () => {
      const h = await mountSignedIn({ links: [link(1)] });
      h.server.fail('POST /api/admin/links', 409);
      // 409 with a generic body: the Panel reads the status.
      fill(h, 'X', 'https://x.com');
      await settle();
      expect(
        text(h.root.querySelector('p[role="status"][aria-live="polite"]:not(.connection)')),
      ).toBeDefined();
    });

    test('invalid data shows a notice and keeps what was typed', async () => {
      const h = await mountSignedIn({ links: [link(1)] });
      h.server.fail('POST /api/admin/links', 400);
      fill(h, 'Título', 'https://x.com');
      await settle();
      expect(h.root.textContent).toContain('Revisa el título y la URL');
      expect(rowTitles(h)).toEqual(['Enlace 1']);
    });
  });

  describe('editing and switching', () => {
    test('"Editar" opens a form with the values, "Guardar" sends them, and the list updates', async () => {
      const h = await mountSignedIn({ links: [link(1), link(2)] });
      buttonNamed(h.root, 'Editar «Enlace 1»').click();
      await settle();

      const title = h.root.querySelector('.edit-form input[type="text"]') as HTMLInputElement;
      const url = h.root.querySelector('.edit-form input[type="url"]') as HTMLInputElement;
      expect(title.value).toBe('Enlace 1');
      expect(url.value).toBe('https://ejemplo.com/1');
      title.value = 'Renombrado';
      url.value = 'https://nuevo.com';
      (h.root.querySelector('.edit-form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await settle();

      const patch = h.server.callsTo('PATCH', '/api/admin/links/link-1')[0];
      expect(JSON.parse(patch?.body ?? '{}')).toEqual({
        title: 'Renombrado',
        url: 'https://nuevo.com',
      });
      expect(rowTitles(h)).toEqual(['Renombrado', 'Enlace 2']);
      expect(h.root.querySelector('.edit-form')).toBeNull();
    });

    test('"Cancelar" closes the form without sending anything', async () => {
      const h = await mountSignedIn({ links: [link(1)] });
      buttonNamed(h.root, 'Editar «Enlace 1»').click();
      await settle();
      const calls = h.server.calls.length;
      (h.root.querySelector('.edit-form .js-cancel') as HTMLButtonElement).click();
      await settle();
      expect(h.root.querySelector('.edit-form')).toBeNull();
      expect(h.server.calls.length).toBe(calls);
      expect(document.activeElement).toBe(buttonNamed(h.root, 'Editar «Enlace 1»'));
    });

    test('a live update does not wipe what is being typed in an edit form', async () => {
      const h = await mountSignedIn({ links: [link(1)] });
      h.sockets[0]?.open();
      await settle();
      buttonNamed(h.root, 'Editar «Enlace 1»').click();
      await settle();
      const title = h.root.querySelector('.edit-form input[type="text"]') as HTMLInputElement;
      title.value = 'A medio escribir';

      live(h, emptySnapshot({ totals: { clicks: 9, visits: 1 }, links: { 'link-1': 9 } }));

      const same = h.root.querySelector('.edit-form input[type="text"]') as HTMLInputElement;
      expect(same).toBe(title);
      expect(same.value).toBe('A medio escribir');
      expect(text(h.root.querySelector('[data-total="clicks"]'))).toBe('9');
    });

    test('"Desactivar" sends the state, the label flips and the keyboard focus stays', async () => {
      const h = await mountSignedIn({ links: [link(1)] });
      buttonNamed(h.root, 'Desactivar «Enlace 1»').click();
      await settle();

      expect(
        JSON.parse(h.server.callsTo('PATCH', '/api/admin/links/link-1')[0]?.body ?? '{}'),
      ).toEqual({
        active: false,
      });
      expect(text(h.root.querySelector('.link-state'))).toBe('Inactivo');
      expect(buttonNamed(h.root, 'Activar «Enlace 1»')).toBeDefined();
      expect(document.activeElement).toBe(buttonNamed(h.root, 'Activar «Enlace 1»'));
    });

    test('editing a link that no longer exists: a notice and the list is loaded again (6.15)', async () => {
      const h = await mountSignedIn({ links: [link(1), link(2)] });
      h.server.links = [link(2)]; // deleted somewhere else
      buttonNamed(h.root, 'Desactivar «Enlace 1»').click();
      await settle();

      expect(h.root.textContent).toContain('La lista de enlaces ha cambiado');
      expect(rowTitles(h)).toEqual(['Enlace 2']);
    });
  });

  describe('reordering', () => {
    test('the first link cannot go up and the last cannot go down', async () => {
      const h = await mountSignedIn({ links: [link(1), link(2), link(3)] });
      expect(buttonNamed(h.root, 'Subir «Enlace 1»').disabled).toBe(true);
      expect(buttonNamed(h.root, 'Bajar «Enlace 3»').disabled).toBe(true);
      expect(buttonNamed(h.root, 'Subir «Enlace 2»').disabled).toBe(false);
    });

    test('moving down sends the new order and shows it (6.4, 6.14)', async () => {
      const h = await mountSignedIn({ links: [link(1), link(2), link(3)] });
      buttonNamed(h.root, 'Bajar «Enlace 1»').click();
      await settle();

      const put = h.server.callsTo('PUT', '/api/admin/links/order')[0];
      expect(JSON.parse(put?.body ?? '{}')).toEqual({ ids: ['link-2', 'link-1', 'link-3'] });
      expect(rowTitles(h)).toEqual(['Enlace 2', 'Enlace 1', 'Enlace 3']);
    });

    test('the keyboard focus follows the link that moved (15.1)', async () => {
      const h = await mountSignedIn({ links: [link(1), link(2), link(3)] });
      buttonNamed(h.root, 'Bajar «Enlace 1»').click();
      await settle();
      expect(document.activeElement).toBe(buttonNamed(h.root, 'Bajar «Enlace 1»'));

      buttonNamed(h.root, 'Bajar «Enlace 1»').click();
      await settle();
      // It reached the end: the "down" button is disabled, so the focus goes to "up".
      expect(rowTitles(h)).toEqual(['Enlace 2', 'Enlace 3', 'Enlace 1']);
      expect(document.activeElement).toBe(buttonNamed(h.root, 'Subir «Enlace 1»'));
    });

    test('a stale list: the server rejects the order, a notice, and the list is loaded again (6.15)', async () => {
      const h = await mountSignedIn({ links: [link(1), link(2)] });
      h.server.links = [link(1), link(2), link(3)]; // a link was added elsewhere
      buttonNamed(h.root, 'Bajar «Enlace 1»').click();
      await settle();

      expect(h.root.textContent).toContain('La lista de enlaces ha cambiado');
      expect(rowTitles(h)).toEqual(['Enlace 1', 'Enlace 2', 'Enlace 3']);
    });
  });

  describe('deleting (6.16)', () => {
    const dialog = (): HTMLDialogElement | null => document.querySelector('dialog');

    test('asks first, naming the link and warning that its clicks are lost, with focus on "Cancelar"', async () => {
      const h = await mountSignedIn({ links: [link(1, { title: 'Mi blog' })] });
      buttonNamed(h.root, 'Eliminar «Mi blog»').click();
      await settle();

      const open = dialog();
      expect(open).not.toBeNull();
      expect(text(open?.querySelector('h2'))).toBe('Eliminar enlace');
      expect(text(open?.querySelector('p'))).toBe(
        'Vas a eliminar «Mi blog». Se perderá su contador de clics.',
      );
      expect(open?.getAttribute('aria-labelledby')).toBeTruthy();
      expect(document.activeElement).toBe(buttonNamed(open as HTMLElement, 'Cancelar'));
      // Nothing has been sent yet.
      expect(h.server.callsTo('DELETE', '/api/admin/links/link-1')).toHaveLength(0);
    });

    test('"Cancelar" and Escape close it and send nothing', async () => {
      const h = await mountSignedIn({ links: [link(1)] });
      // Like a real click or Enter: the button has the focus when the dialog opens.
      const open = (): void => {
        const trigger = buttonNamed(h.root, 'Eliminar «Enlace 1»');
        trigger.focus();
        trigger.click();
      };
      open();
      await settle();
      buttonNamed(dialog() as HTMLElement, 'Cancelar').click();
      await settle();
      expect(dialog()).toBeNull();

      open();
      await settle();
      dialog()?.dispatchEvent(new Event('cancel', { cancelable: true }));
      await settle();
      expect(dialog()).toBeNull();

      expect(h.server.callsTo('DELETE', '/api/admin/links/link-1')).toHaveLength(0);
      expect(rowTitles(h)).toEqual(['Enlace 1']);
      expect(document.activeElement).toBe(buttonNamed(h.root, 'Eliminar «Enlace 1»'));
    });

    test('confirming deletes the link and shows the updated list', async () => {
      const h = await mountSignedIn({ links: [link(1), link(2)] });
      buttonNamed(h.root, 'Eliminar «Enlace 1»').click();
      await settle();
      buttonNamed(dialog() as HTMLElement, 'Eliminar').click();
      await settle();

      expect(h.server.callsTo('DELETE', '/api/admin/links/link-1')).toHaveLength(1);
      expect(dialog()).toBeNull();
      expect(rowTitles(h)).toEqual(['Enlace 2']);
      // The focused button is gone: focus moves to the section heading, not lost.
      expect(document.activeElement).toBe(h.root.querySelector('#links-heading'));
    });

    test('a link that was already deleted elsewhere: a notice and a fresh list', async () => {
      const h = await mountSignedIn({ links: [link(1), link(2)] });
      buttonNamed(h.root, 'Eliminar «Enlace 1»').click();
      await settle();
      h.server.links = [link(2)];
      buttonNamed(dialog() as HTMLElement, 'Eliminar').click();
      await settle();

      expect(h.root.textContent).toContain('La lista de enlaces ha cambiado');
      expect(rowTitles(h)).toEqual(['Enlace 2']);
    });
  });
});

describe('resetting the metrics (16)', () => {
  const dialog = (): HTMLDialogElement | null => document.querySelector('dialog');
  const resetButton = (h: PanelHarness): HTMLButtonElement =>
    buttonNamed(h.root, 'Reiniciar métricas');

  test('asks first: what will happen, that it cannot be undone, "Reiniciar" and "Cancelar" with focus on "Cancelar" (16.1)', async () => {
    const h = await mountSignedIn();
    resetButton(h).click();
    await settle();

    const open = dialog();
    expect(text(open?.querySelector('p'))).toBe(
      'Todos los contadores y el feed de actividad se pondrán a cero. Esta acción no se puede deshacer.',
    );
    const labels = all(open as HTMLElement, 'button').map((button) => text(button));
    expect(labels).toEqual(['Cancelar', 'Reiniciar']);
    expect(document.activeElement).toBe(buttonNamed(open as HTMLElement, 'Cancelar'));
    expect(h.server.callsTo('POST', '/api/admin/metrics/reset')).toHaveLength(0);
  });

  test('"Cancelar" and closing the dialog send nothing (16.2)', async () => {
    const h = await mountSignedIn();
    resetButton(h).click();
    await settle();
    buttonNamed(dialog() as HTMLElement, 'Cancelar').click();
    await settle();
    resetButton(h).click();
    await settle();
    dialog()?.dispatchEvent(new Event('cancel', { cancelable: true }));
    await settle();

    expect(h.server.callsTo('POST', '/api/admin/metrics/reset')).toHaveLength(0);
    expect(dialog()).toBeNull();
  });

  test('confirming resets and shows everything at zero, with the feed emptied (16.6)', async () => {
    const h = await mountSignedIn({
      links: [link(1)],
      snapshot: emptySnapshot({
        totals: { clicks: 30, visits: 9 },
        links: { 'link-1': 30 },
        channels: { qr: { clicks: 30, visits: 9 } },
        events: [event('e1', 'click', 'qr', 0, 'Enlace 1')],
      }),
    });
    expect(text(h.root.querySelector('[data-total="clicks"]'))).toBe('30');

    resetButton(h).click();
    await settle();
    buttonNamed(dialog() as HTMLElement, 'Reiniciar').click();
    await settle();

    expect(h.server.callsTo('POST', '/api/admin/metrics/reset')).toHaveLength(1);
    expect(text(h.root.querySelector('[data-total="clicks"]'))).toBe('0');
    expect(text(h.root.querySelector('[data-total="visits"]'))).toBe('0');
    expect(text(h.root.querySelector('.link-clicks strong'))).toBe('0');
    expect(all(h.root, '[data-channel]')).toHaveLength(0);
    expect(all(h.root, '.feed-item')).toHaveLength(0);
    // The links themselves are untouched.
    expect(rowTitles(h)).toEqual(['Enlace 1']);
  });

  test('a failed reset says so and keeps the values shown (16.4)', async () => {
    const h = await mountSignedIn({
      snapshot: emptySnapshot({ totals: { clicks: 30, visits: 9 } }),
    });
    h.server.fail('POST /api/admin/metrics/reset', 500);
    resetButton(h).click();
    await settle();
    buttonNamed(dialog() as HTMLElement, 'Reiniciar').click();
    await settle();

    expect(h.root.textContent).toContain('No se han podido reiniciar las métricas');
    expect(text(h.root.querySelector('[data-total="clicks"]'))).toBe('30');
    expect(text(h.root.querySelector('[data-total="visits"]'))).toBe('9');
  });
});
