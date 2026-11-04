// Activity feed (task 15.11, Requirements 9.5, 9.6, 14.9).

import type { ActivityEvent } from '@link-in-bio/shared';

import { PANEL } from '../../lib/messages.js';
import { formatClock } from '../format.js';

import { h, setChildren } from './dom.js';

/** The event type in Spanish. */
function kindOf(event: ActivityEvent): string {
  return event.type === 'click' ? PANEL.eventClick : PANEL.eventVisit;
}

/**
 * Draws the feed in the order received (newest first). Each entry shows the time
 * as HH:MM:SS in the browser's time zone, the type ("Clic" or "Visita"), the link
 * title when it is a click, and the channel. Titles are plain text (14.9).
 */
export function renderFeed(
  container: HTMLElement,
  events: readonly ActivityEvent[],
  timeZone?: string,
): void {
  const doc = container.ownerDocument;

  if (events.length === 0) {
    setChildren(container, h(doc, 'p', { class: 'message', text: PANEL.noActivity }));
    return;
  }

  setChildren(
    container,
    h(
      doc,
      'ol',
      { class: 'feed' },
      ...events.map((event) =>
        h(
          doc,
          'li',
          { class: `feed-item feed-item--${event.type}` },
          h(doc, 'time', {
            class: 'feed-time',
            text: formatClock(event.at, timeZone),
            attrs: { datetime: event.at },
          }),
          h(doc, 'span', { class: 'feed-kind', text: kindOf(event) }),
          event.title === undefined
            ? null
            : h(doc, 'span', { class: 'feed-title', text: event.title }),
          h(doc, 'span', { class: 'feed-channel', text: event.channel }),
        ),
      ),
    ),
  );
}
