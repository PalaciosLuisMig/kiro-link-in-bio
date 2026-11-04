// Link activation: register the click and take the visitor to the destination
// (Requirements 2.1 to 2.4).
//
// Pure logic with `fetch` and `navigate` injected, so it is tested without a
// browser or a network.

import { API_ROUTES } from '@link-in-bio/shared';

import { postJson, type FetchLike } from '../lib/api.js';

export interface ClickDeps {
  readonly fetch: FetchLike;
  /** Takes the visitor to the URL in the same tab (`location.assign`). */
  readonly navigate: (url: string) => void;
  /** Channel of this page load: the same for the visit and every click (4.1). */
  readonly channel: string | undefined;
}

/** Attribute of each link anchor with the id of its link. */
export const LINK_ID_ATTRIBUTE = 'data-link-id';

const LINK_SELECTOR = `a[${LINK_ID_ATTRIBUTE}]`;

/** The link anchor an event came from, if any. */
function linkOf(event: Event): HTMLAnchorElement | null {
  const target = event.target;
  return target instanceof Element ? target.closest<HTMLAnchorElement>(LINK_SELECTOR) : null;
}

/**
 * Sends the click without waiting and without retrying (2.1, 2.4).
 *
 * `keepalive` lets the request continue after the page is gone, and any failure
 * is swallowed: the visitor must reach the destination and never see an error.
 */
function reportClick(deps: ClickDeps, anchor: HTMLAnchorElement): void {
  const linkId = anchor.getAttribute(LINK_ID_ATTRIBUTE);
  if (linkId === null) {
    return;
  }
  const body = deps.channel === undefined ? { linkId } : { linkId, channel: deps.channel };
  try {
    postJson(deps.fetch, API_ROUTES.clicks, body, { keepalive: true }).catch(() => {});
  } catch {
    // `fetch` can throw synchronously (for example on an invalid argument).
  }
}

/**
 * Handles the activation of the links inside `container` by delegation, so it
 * keeps working when the list is rendered again.
 *
 * - Primary activation (touch, primary button, Enter): the click is sent and
 *   the visitor is taken to the destination in the SAME tick, before any wait
 *   (2.2). With Ctrl, Cmd, Shift or Alt the default is left alone so the
 *   browser opens a new tab or window, but the click is still counted (2.3).
 * - Middle button (`auxclick`): the click is sent and the browser opens the new
 *   tab by itself (2.3).
 *
 * Each activation sends exactly one request: a middle click fires `auxclick`
 * and no `click`, and `click` is ignored for any button but the primary one.
 */
export function attachClickHandling(container: HTMLElement, deps: ClickDeps): void {
  container.addEventListener('click', (event: MouseEvent) => {
    const anchor = linkOf(event);
    if (anchor === null || event.button !== 0) {
      return;
    }
    reportClick(deps, anchor);

    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    const url = anchor.getAttribute('href');
    if (url === null) {
      return;
    }
    event.preventDefault();
    deps.navigate(url);
  });

  container.addEventListener('auxclick', (event: MouseEvent) => {
    const anchor = linkOf(event);
    if (anchor === null || event.button !== 1) {
      return;
    }
    reportClick(deps, anchor);
  });
}
