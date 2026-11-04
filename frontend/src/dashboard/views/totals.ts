// Totals and channels (task 15.11, Requirements 7.2, 7.4, 8.3).

import { PANEL } from '../../lib/messages.js';
import type { ChannelRow } from '../store.js';

import { h, setChildren } from './dom.js';

/** The two big counters: all clicks and all visits, 0 when there is none (7.2). */
export function renderTotals(
  container: HTMLElement,
  totals: { readonly clicks: number; readonly visits: number },
): void {
  const doc = container.ownerDocument;
  const item = (label: string, value: number, key: string) =>
    h(
      doc,
      'div',
      { class: 'total' },
      h(doc, 'dt', { text: label }),
      h(doc, 'dd', { text: String(value), attrs: { 'data-total': key } }),
    );

  setChildren(
    container,
    h(
      doc,
      'dl',
      { class: 'totals' },
      item(PANEL.clicks, totals.clicks, 'clicks'),
      item(PANEL.visits, totals.visits, 'visits'),
    ),
  );
}

/** Channels with activity, in the order given (already sorted by the store). */
export function renderChannels(container: HTMLElement, rows: readonly ChannelRow[]): void {
  const doc = container.ownerDocument;

  if (rows.length === 0) {
    setChildren(container, h(doc, 'p', { class: 'message', text: PANEL.noChannels }));
    return;
  }

  setChildren(
    container,
    h(
      doc,
      'table',
      { class: 'table' },
      h(doc, 'caption', { class: 'visually-hidden', text: PANEL.channelsHeading }),
      h(
        doc,
        'thead',
        {},
        h(
          doc,
          'tr',
          {},
          h(doc, 'th', { text: PANEL.channelName, attrs: { scope: 'col' } }),
          h(doc, 'th', { text: PANEL.clicks, attrs: { scope: 'col' }, class: 'num' }),
          h(doc, 'th', { text: PANEL.visits, attrs: { scope: 'col' }, class: 'num' }),
        ),
      ),
      h(
        doc,
        'tbody',
        {},
        ...rows.map((row) =>
          h(
            doc,
            'tr',
            { attrs: { 'data-channel': row.name } },
            h(doc, 'th', { text: row.name, attrs: { scope: 'row' } }),
            h(doc, 'td', { text: String(row.clicks), class: 'num' }),
            h(doc, 'td', { text: String(row.visits), class: 'num' }),
          ),
        ),
      ),
    ),
  );
}
