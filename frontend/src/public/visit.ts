// Visit registration: one per page load, after the list is shown
// (Requirements 3.1 to 3.6).

import { API_ROUTES } from '@link-in-bio/shared';

import { postJson, REQUEST_TIMEOUT_MS, type FetchLike } from '../lib/api.js';

export interface VisitDeps {
  readonly fetch: FetchLike;
  /** Channel of this page load: the same for the visit and every click (4.1). */
  readonly channel: string | undefined;
}

export interface VisitReporter {
  /** Sends the visit the first time it is called and does nothing afterwards. */
  report(): void;
}

/**
 * Creates the reporter of the visit of this page load.
 *
 * `report` is idempotent, so the page can call it after every successful
 * paint (also after "Reintentar") and still count one visit (3.1). It never
 * waits, retries or shows anything: a failure or no answer in 5 s leaves the
 * page exactly as it is (3.3, 3.5).
 *
 * Restoring the page from the back/forward cache does not run the script again,
 * and nothing here listens for `pageshow`, so no new visit is counted (3.6).
 */
export function createVisitReporter(deps: VisitDeps): VisitReporter {
  let sent = false;
  return {
    report() {
      if (sent) {
        return;
      }
      sent = true;
      const body = deps.channel === undefined ? {} : { channel: deps.channel };
      try {
        postJson(deps.fetch, API_ROUTES.visits, body, { timeoutMs: REQUEST_TIMEOUT_MS }).catch(
          () => {},
        );
      } catch {
        // `fetch` can throw synchronously; the visit is simply lost.
      }
    },
  };
}
