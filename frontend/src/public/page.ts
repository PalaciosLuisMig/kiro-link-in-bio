// Orchestration of the public page: load, show, retry and register the visit.
//
// Kept apart from `main.ts` (which only reads the browser globals) so it is
// tested with a fake `fetch`, a fake `navigate` and a DOM from happy-dom.

import { API_ROUTES, type PublicLinksResponse } from '@link-in-bio/shared';

import { getJson, type FetchLike } from '../lib/api.js';

import { readChannel } from './channel.js';
import { attachClickHandling } from './click.js';
import { showEmpty, showError, showLinks, showLoading } from './links-view.js';
import { createVisitReporter } from './visit.js';

export interface PublicPageDeps {
  readonly fetch: FetchLike;
  /** Takes the visitor to a URL in the same tab (`location.assign`). */
  readonly navigate: (url: string) => void;
  /** The query string of the page, e.g. `location.search`. */
  readonly search: string;
}

/**
 * Starts the public page inside `container`.
 *
 * Order of the actions (Requirements 1, 3):
 * 1. show "Cargando enlaces…" and ask `GET /api/links` with a 5 s limit;
 * 2. on success paint the list (or the empty message) and THEN report the
 *    visit, without waiting for its answer. The visit goes out once per page
 *    load, also when it took "Reintentar" to get the list;
 * 3. on failure show the error and "Reintentar", and send no visit.
 *
 * The page uses no cookies, `localStorage` or `sessionStorage` (11.3).
 *
 * @returns a promise that settles when the first load is done (for tests).
 */
export function startPublicPage(container: HTMLElement, deps: PublicPageDeps): Promise<void> {
  // One channel for the whole page load: the visit and every click share it.
  const channel = readChannel(deps.search);
  const visit = createVisitReporter({ fetch: deps.fetch, channel });
  attachClickHandling(container, { fetch: deps.fetch, navigate: deps.navigate, channel });

  let loading = false;

  const load = async (): Promise<void> => {
    if (loading) {
      return;
    }
    loading = true;
    showLoading(container);
    try {
      const { links } = await getJson<PublicLinksResponse>(deps.fetch, API_ROUTES.publicLinks);
      if (links.length === 0) {
        showEmpty(container);
      } else {
        showLinks(container, links);
      }
      visit.report();
    } catch {
      showError(container, () => {
        void load();
      });
    } finally {
      loading = false;
    }
  };

  return load();
}
