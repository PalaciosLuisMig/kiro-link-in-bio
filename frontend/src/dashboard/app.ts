// The Panel: wires the session, the API, the real-time client, the reducer and the
// views (tasks 15.6 to 15.11).
//
// It holds no rules of its own that are not in a tested pure piece: the reducer
// decides what the data is, `auth.ts` what a sign-in means, `realtime.ts` how to
// reconnect and `refresh-policy.ts` when to ask again. This file only connects
// them and draws.

import type { AdminLink, MetricsSnapshot } from '@link-in-bio/shared';

import { ApiError, type FetchLike } from '../lib/api.js';
import { MESSAGES, PANEL, panelLabel } from '../lib/messages.js';

import { ANNOUNCE_INTERVAL_MS, createAnnouncer } from './announcer.js';
import { createAdminApi, UnauthorizedError } from './api.js';
import { createSession, resumeSession, signIn, type TokenStorage } from './auth.js';
import {
  createRateLimiter,
  createUnknownLinkTracker,
  REFETCH_MIN_INTERVAL_MS,
} from './refresh-policy.js';
import {
  startRealtime,
  type ConnectionStatus,
  type RealtimeClient,
  type WebSocketLike,
} from './realtime.js';
import {
  advanceClock,
  applySnapshot,
  countNewEvents,
  initialState,
  sortedChannels,
  windowMinutes,
  type DashboardState,
} from './store.js';
import { renderChart } from './views/chart.js';
import { confirmDialog } from './views/dialog.js';
import { h, setChildren } from './views/dom.js';
import { renderFeed } from './views/feed.js';
import { createLinksView, type LinksView } from './views/links.js';
import { renderLogin } from './views/login.js';
import { renderChannels, renderTotals } from './views/totals.js';

export interface PanelDeps {
  readonly fetch: FetchLike;
  /** `window.sessionStorage`, or `null` when it is not available. */
  readonly storage: TokenStorage | null;
  readonly createSocket: (url: string) => WebSocketLike;
  /** The browser clock, in ms (`Date.now`). */
  readonly now: () => number;
  /** Time zone of the times shown; the browser's own when omitted. */
  readonly timeZone?: string;
}

export interface PanelHandle {
  /** Settles when the first screen (the form or the dashboard) is shown. */
  readonly ready: Promise<void>;
  /** Stops the real-time client and every timer. */
  stop(): void;
}

/** How often the corrected clock is checked for a new minute (8.4). */
const TICK_MS = 1000;

/** What to tell the owner when an action on the links fails. */
function linkFailureNotice(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http') {
    // The list changed under the owner's feet: say so and load it again (6.15).
    if (error.status === 404 || error.reason === 'ids_not_permutation') {
      return PANEL.listChanged;
    }
    if (error.status === 409 || error.code === 'limit_reached') {
      return PANEL.linkLimit;
    }
    if (error.status === 400) {
      return PANEL.linkInvalid;
    }
  }
  return PANEL.linkFailed;
}

/** True when a failed action means the list the Panel shows is out of date. */
function listIsStale(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.kind === 'http' &&
    (error.status === 404 || error.status === 409 || error.reason === 'ids_not_permutation')
  );
}

export function startPanel(root: HTMLElement, deps: PanelDeps): PanelHandle {
  const doc = root.ownerDocument;
  const session = createSession(deps.storage);
  const api = createAdminApi({ fetch: deps.fetch, getToken: () => session.token() });
  let teardown: (() => void) | null = null;

  const showLogin = (message = ''): void => {
    teardown?.();
    teardown = null;
    const login = renderLogin(root, async (rawToken) => {
      login.setMessage('');
      login.setBusy(true);
      let links: AdminLink[] = [];
      const result = await signIn(
        {
          session,
          validate: async () => {
            links = await api.listLinks();
          },
        },
        rawToken,
      );
      if (result === 'ok') {
        showDashboard(links);
        return;
      }
      login.setBusy(false);
      login.setMessage(
        result === 'empty'
          ? PANEL.tokenRequired
          : result === 'unauthorized'
            ? PANEL.tokenInvalid
            : PANEL.serverUnreachable,
      );
      login.focus();
    });
    login.setMessage(message);
    login.focus();
  };

  const showDashboard = (initialLinks: readonly AdminLink[]): void => {
    teardown?.();

    // --- Skeleton, built once -------------------------------------------------
    const connectionEl = h(doc, 'p', {
      class: 'connection',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    const noticeEl = h(doc, 'p', {
      class: 'message',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    const announcerEl = h(doc, 'p', {
      class: 'visually-hidden',
      attrs: { 'aria-live': 'polite', 'data-announcer': '' },
    });
    const statusEl = h(doc, 'div', { class: 'metrics-status' });

    const totalsBox = h(doc, 'div');
    const chartBox = h(doc, 'div', { class: 'chart-box' });
    const channelsBox = h(doc, 'div');
    const feedBox = h(doc, 'div');
    const linksBox = h(doc, 'section', { class: 'panel-section panel-section--links' });

    const section = (title: string, box: HTMLElement, extra = ''): HTMLElement =>
      h(
        doc,
        'section',
        { class: `panel-section ${extra}`.trim(), attrs: { hidden: '' } },
        h(doc, 'h2', { class: 'section-title', text: title }),
        box,
      );
    const totalsSection = section(PANEL.totalsHeading, totalsBox, 'panel-section--totals');
    const chartSection = section(PANEL.chartHeading, chartBox, 'panel-section--chart');
    const channelsSection = section(PANEL.channelsHeading, channelsBox, 'panel-section--channels');
    const feedSection = section(PANEL.feedHeading, feedBox, 'panel-section--feed');
    const metricSections = [totalsSection, chartSection, channelsSection, feedSection];

    const resetButton = h(doc, 'button', {
      class: 'button',
      text: PANEL.resetMetrics,
      attrs: { type: 'button' },
    });
    const signOutButton = h(doc, 'button', {
      class: 'button',
      text: PANEL.signOut,
      attrs: { type: 'button' },
    });

    setChildren(
      root,
      h(
        doc,
        'div',
        { class: 'dashboard' },
        h(
          doc,
          'div',
          { class: 'toolbar' },
          connectionEl,
          h(doc, 'div', { class: 'toolbar-actions' }, resetButton, signOutButton),
        ),
        noticeEl,
        announcerEl,
        statusEl,
        h(
          doc,
          'div',
          { class: 'panel-grid' },
          h(
            doc,
            'div',
            { class: 'panel-col' },
            totalsSection,
            chartSection,
            channelsSection,
            feedSection,
          ),
          h(doc, 'div', { class: 'panel-col' }, linksBox),
        ),
      ),
    );

    // --- State ----------------------------------------------------------------
    let state: DashboardState = initialState();
    let links: AdminLink[] = [...initialLinks];
    let metricsView: 'loading' | 'error' | 'ready' = 'loading';
    let busy = false;
    let stopped = false;
    let realtime: RealtimeClient | null = null;

    const limiter = createRateLimiter(REFETCH_MIN_INTERVAL_MS);
    const unknownLinks = createUnknownLinkTracker();
    const announcer = createAnnouncer({
      element: announcerEl,
      now: deps.now,
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      intervalMs: ANNOUNCE_INTERVAL_MS,
    });

    const clicksOf = (id: string): number =>
      state.hasSnapshot
        ? (state.links.get(id) ?? 0)
        : (links.find((link) => link.id === id)?.clicks ?? 0);

    // --- Drawing --------------------------------------------------------------
    const linksView: LinksView = createLinksView(linksBox, {
      create: (draft) => runLinkAction(() => api.createLink(draft).then(refreshLinks)),
      update: (id, patch) => runLinkAction(() => api.updateLink(id, patch).then(refreshLinks)),
      move: async (id, direction) => {
        const ids = links.map((link) => link.id);
        const from = ids.indexOf(id);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= ids.length) {
          return;
        }
        [ids[from], ids[to]] = [ids[to] as string, ids[from] as string];
        const moved = await runLinkAction(async () => {
          links = await api.reorderLinks(ids);
          linksView.render(links, clicksOf);
        });
        if (moved) {
          linksView.focusControl(id, direction < 0 ? 'up' : 'down');
        }
      },
      remove: async (link) => {
        const confirmed = await confirmDialog(doc, {
          title: PANEL.removeTitle,
          message: panelLabel.removeMessage(link.title),
          confirmLabel: PANEL.confirmRemove,
          cancelLabel: PANEL.cancel,
        });
        if (!confirmed) {
          return;
        }
        const removed = await runLinkAction(() => api.deleteLink(link.id).then(refreshLinks));
        if (removed) {
          // The button that had the focus is gone: do not drop it on the page.
          linksView.focusHeading();
        }
      },
    });
    linksView.render(links, clicksOf);

    const setNotice = (text: string): void => {
      noticeEl.textContent = text;
    };

    const drawMetricsStatus = (): void => {
      if (metricsView === 'loading') {
        setChildren(
          statusEl,
          h(doc, 'p', { class: 'message', text: PANEL.metricsLoading, attrs: { role: 'status' } }),
        );
      } else if (metricsView === 'error') {
        const retry = h(doc, 'button', {
          class: 'button button--primary',
          text: MESSAGES.retry,
          attrs: { type: 'button' },
        });
        retry.addEventListener('click', () => void loadMetrics(true));
        setChildren(
          statusEl,
          h(
            doc,
            'div',
            { attrs: { role: 'alert' } },
            h(doc, 'p', { class: 'message message--error', text: PANEL.metricsLoadError }),
            retry,
          ),
        );
      } else {
        setChildren(statusEl);
      }
      // No partial values: the numbers show only when the metrics are ready (7.8).
      for (const element of metricSections) {
        element.toggleAttribute('hidden', metricsView !== 'ready');
      }
    };

    const drawChart = (): void => renderChart(chartBox, windowMinutes(state), deps.timeZone);

    const drawMetrics = (): void => {
      drawMetricsStatus();
      if (metricsView !== 'ready') {
        return;
      }
      renderTotals(totalsBox, state.totals);
      drawChart();
      renderChannels(channelsBox, sortedChannels(state));
      renderFeed(feedBox, state.events, deps.timeZone);
    };

    // --- Data -----------------------------------------------------------------
    const forceLogout = (): void => {
      session.clear();
      showLogin(PANEL.tokenInvalid);
    };

    const refreshLinks = async (): Promise<void> => {
      links = await api.listLinks();
      if (stopped) {
        return;
      }
      linksView.render(links, clicksOf);
      unknownLinks.resolve(new Set(links.map((link) => link.id)));
    };

    /** Refreshes the list without surfacing errors: a refresh must never disturb the owner. */
    const refreshLinksQuietly = async (): Promise<void> => {
      try {
        await refreshLinks();
      } catch (error) {
        if (error instanceof UnauthorizedError && !stopped) {
          forceLogout();
        }
      }
    };

    /** The only way data enters the state: the HTTP answer and every message use it. */
    const receive = (snapshot: MetricsSnapshot): void => {
      if (stopped) {
        return;
      }
      const previous = state;
      state = applySnapshot(state, snapshot, deps.now());
      if (state === previous) {
        return; // an older epoch: dropped whole (8.6)
      }
      // The first fill of the feed (or a reset) is not "new activity" to announce.
      if (previous.hasSnapshot && previous.epoch === state.epoch) {
        announcer.add(countNewEvents(previous, state));
      }
      metricsView = 'ready';
      drawMetrics();
      linksView.updateCounts(clicksOf);

      // A link the Panel does not show: ask again, at most once every 5 s (8.11).
      const known = new Set(links.map((link) => link.id));
      const unknown = unknownLinks.check(Object.keys(snapshot.links), known);
      if (unknown.length > 0 && limiter.tryAcquire(deps.now())) {
        void refreshLinksQuietly();
        void loadMetrics(false);
      }
    };

    /**
     * Asks for the metrics. `explicit` is the first load, "Reintentar" and the one
     * after a reset: a failure shows the error. A background refresh keeps what is
     * shown and fails silently.
     */
    const loadMetrics = async (explicit: boolean): Promise<void> => {
      if (explicit && !state.hasSnapshot) {
        metricsView = 'loading';
        drawMetricsStatus();
      }
      try {
        receive(await api.getMetrics());
      } catch (error) {
        if (stopped) {
          return;
        }
        if (error instanceof UnauthorizedError) {
          forceLogout();
          return;
        }
        if (explicit) {
          metricsView = 'error';
          drawMetrics();
        }
      }
    };

    /**
     * Runs an action on the links: nothing else is sent meanwhile, a 401 ends the
     * session, and a failure becomes a clear notice (6.15). Resolves whether it worked.
     */
    async function runLinkAction(
      action: () => Promise<unknown>,
      failure?: string,
    ): Promise<boolean> {
      if (busy || stopped) {
        return false;
      }
      busy = true;
      linksView.setBusy(true);
      setNotice('');
      try {
        await action();
        return true;
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          if (!stopped) {
            forceLogout();
          }
          return false;
        }
        setNotice(failure ?? linkFailureNotice(error));
        if (listIsStale(error)) {
          void refreshLinksQuietly();
        }
        return false;
      } finally {
        if (!stopped) {
          busy = false;
          linksView.setBusy(false);
        }
      }
    }

    // --- Buttons --------------------------------------------------------------
    resetButton.addEventListener('click', () => {
      void (async () => {
        const confirmed = await confirmDialog(doc, {
          title: PANEL.resetTitle,
          message: PANEL.resetMessage,
          confirmLabel: PANEL.confirmReset,
          cancelLabel: PANEL.cancel,
        });
        if (!confirmed) {
          return;
        }
        await runLinkAction(async () => {
          await api.resetMetrics();
          await loadMetrics(true);
        }, PANEL.resetError);
      })();
    });

    signOutButton.addEventListener('click', () => {
      session.clear();
      showLogin();
    });

    // --- Real time ------------------------------------------------------------
    const showStatus = (status: ConnectionStatus): void => {
      connectionEl.textContent =
        status === 'connecting'
          ? PANEL.connecting
          : status === 'reconnecting'
            ? PANEL.reconnecting
            : '';
    };

    drawMetrics();
    void loadMetrics(true);
    realtime = startRealtime({
      api,
      createSocket: deps.createSocket,
      onSnapshot: receive,
      onStatus: showStatus,
      onUnauthorized: forceLogout,
    });

    // A new minute on the corrected clock moves the chart (8.4).
    const tick = setInterval(() => {
      const next = advanceClock(state, deps.now());
      if (next !== state) {
        state = next;
        if (metricsView === 'ready') {
          drawChart();
        }
      }
    }, TICK_MS);

    teardown = () => {
      stopped = true;
      clearInterval(tick);
      realtime?.stop();
      announcer.dispose();
    };
  };

  // --- Start: a reloaded tab keeps the session (5.10) --------------------------
  const ready = (async (): Promise<void> => {
    if (session.token() === null) {
      showLogin();
      return;
    }
    setChildren(
      root,
      h(doc, 'p', { class: 'message', text: PANEL.signingIn, attrs: { role: 'status' } }),
    );
    let links: AdminLink[] = [];
    const result = await resumeSession({
      session,
      validate: async () => {
        links = await api.listLinks();
      },
    });
    if (result === 'ok') {
      showDashboard(links);
    } else if (result === 'unauthorized') {
      showLogin(PANEL.tokenInvalid);
    } else {
      showLogin(PANEL.serverUnreachable);
    }
  })();

  return {
    ready,
    stop: () => {
      teardown?.();
      teardown = null;
    },
  };
}
