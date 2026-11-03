// View of the public page: the four states (loading, list, empty, error).
//
// Everything is built with `createElement` and `textContent`, never with
// `innerHTML`, so a title such as `<script>` is shown as text and creates no
// element (Requirement 14.9).

import type { PublicLink } from '@link-in-bio/shared';

import { MESSAGES } from '../lib/messages.js';

import { LINK_ID_ATTRIBUTE } from './click.js';

function element<K extends keyof HTMLElementTagNameMap>(
  container: HTMLElement,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const created = container.ownerDocument.createElement(tag);
  if (text !== undefined) {
    created.textContent = text;
  }
  return created;
}

/** How many dashed slots show where the keys will be while the list loads. */
const PLACEHOLDER_COUNT = 3;

/**
 * "Cargando enlaces…", announced to assistive technology (1.7), above dashed
 * slots that reserve the place of the links. The slots are purely visual
 * (`aria-hidden`): the status message already tells assistive technology what
 * is happening, and they are not links.
 */
export function showLoading(container: HTMLElement): void {
  const status = element(container, 'p', MESSAGES.loading);
  status.setAttribute('role', 'status');
  status.className = 'message';

  const placeholders = element(container, 'div');
  placeholders.className = 'placeholders';
  placeholders.setAttribute('aria-hidden', 'true');
  for (let slot = 0; slot < PLACEHOLDER_COUNT; slot += 1) {
    const placeholder = element(container, 'span');
    placeholder.className = 'placeholder';
    placeholders.appendChild(placeholder);
  }

  container.replaceChildren(status, placeholders);
}

/** The active links, in the order received, as real anchors (1.1, 1.2). */
export function showLinks(container: HTMLElement, links: readonly PublicLink[]): void {
  const list = element(container, 'ul');
  list.className = 'links';
  for (const link of links) {
    const anchor = element(container, 'a', link.title);
    anchor.setAttribute('href', link.url);
    anchor.setAttribute(LINK_ID_ATTRIBUTE, link.id);
    anchor.className = 'link';
    const item = element(container, 'li');
    item.appendChild(anchor);
    list.appendChild(item);
  }
  container.replaceChildren(list);
}

/** "Todavía no hay enlaces disponibles", with no link element (1.4). */
export function showEmpty(container: HTMLElement): void {
  const message = element(container, 'p', MESSAGES.empty);
  message.className = 'message message--empty';
  container.replaceChildren(message);
}

/** The error message and the "Reintentar" button, with no link element (1.5). */
export function showError(container: HTMLElement, onRetry: () => void): void {
  const wrapper = element(container, 'div');
  wrapper.setAttribute('role', 'alert');
  const message = element(container, 'p', MESSAGES.loadError);
  message.className = 'message';
  const retry = element(container, 'button', MESSAGES.retry);
  retry.setAttribute('type', 'button');
  retry.className = 'retry';
  retry.addEventListener('click', onRetry);
  wrapper.append(message, retry);
  container.replaceChildren(wrapper);
}
