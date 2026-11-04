// Chart of clicks per minute (task 15.11, Requirements 7.3, 8.4, 15.2).
//
// An SVG with `role="img"` for the eye and, next to it, a real `<table>` with the
// 60 minutes and their start time for assistive technology. The table is hidden
// visually with the clip technique and NOT with `display: none`, which would
// remove it from the accessibility tree. Bar geometry uses SVG attributes, never
// a `style` attribute (the Panel's CSP forbids it).

import { PANEL, panelLabel } from '../../lib/messages.js';
import { formatMinute } from '../format.js';
import type { MinuteBar } from '../store.js';

import { h, s, setChildren } from './dom.js';

const WIDTH = 600;
const HEIGHT = 120;
const PLOT_TOP = 6;
const PLOT_HEIGHT = 112;
const BASELINE = PLOT_TOP + PLOT_HEIGHT;

/** The busiest minute, used by the summary read aloud (the first one on a tie). */
function peakOf(bars: readonly MinuteBar[]): MinuteBar | undefined {
  let peak: MinuteBar | undefined;
  for (const bar of bars) {
    if (bar.clicks > 0 && (peak === undefined || bar.clicks > peak.clicks)) {
      peak = bar;
    }
  }
  return peak;
}

/**
 * Draws the chart and its equivalent table for exactly the bars it is given.
 * Re-rendering replaces both, so a new minute is a new bar at 0 and the oldest
 * bar is gone, with no animation to switch off.
 */
export function renderChart(
  container: HTMLElement,
  bars: readonly MinuteBar[],
  timeZone?: string,
): void {
  const doc = container.ownerDocument;
  const total = bars.reduce((sum, bar) => sum + bar.clicks, 0);
  const peak = peakOf(bars);
  const peakClicks = peak?.clicks ?? 0;
  const slot = WIDTH / Math.max(bars.length, 1);

  const summary = panelLabel.chartSummary(
    total,
    peakClicks,
    peak === undefined ? '' : formatMinute(peak.startSec, timeZone),
  );

  const rects = bars.map((bar, index) => {
    const height =
      peakClicks === 0
        ? 0
        : Math.max(bar.clicks > 0 ? 2 : 0, Math.round((bar.clicks / peakClicks) * PLOT_HEIGHT));
    const isLast = index === bars.length - 1;
    return s(
      doc,
      'rect',
      {
        class: isLast ? 'bar bar--now' : 'bar',
        attrs: {
          x: String(Math.round(index * slot + 1)),
          y: String(BASELINE - height),
          width: String(Math.max(Math.floor(slot - 2), 1)),
          height: String(height),
        },
      },
      s(doc, 'title', {
        text: `${formatMinute(bar.startSec, timeZone)} · ${bar.clicks} ${PANEL.clicks.toLowerCase()}`,
      }),
    );
  });

  const first = bars[0];
  const last = bars[bars.length - 1];

  const svg = s(
    doc,
    'svg',
    {
      class: 'chart',
      attrs: {
        viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
        role: 'img',
        'aria-label': summary,
        focusable: 'false',
      },
    },
    s(doc, 'line', {
      class: 'chart-axis',
      attrs: { x1: '0', y1: String(BASELINE), x2: String(WIDTH), y2: String(BASELINE) },
    }),
    ...rects,
  );

  // The first and last minute, as HTML under the chart: text inside the SVG scales
  // down with it and would be tiny on a phone. The table already says it to a
  // screen reader, so this legend is only for the eyes.
  const legend =
    first === undefined || last === undefined
      ? null
      : h(
          doc,
          'p',
          { class: 'chart-legend', attrs: { 'aria-hidden': 'true' } },
          h(doc, 'span', { text: formatMinute(first.startSec, timeZone) }),
          h(doc, 'span', { text: formatMinute(last.startSec, timeZone) }),
        );

  const table = h(
    doc,
    'table',
    { class: 'visually-hidden' },
    h(doc, 'caption', { text: PANEL.chartCaption }),
    h(
      doc,
      'thead',
      {},
      h(
        doc,
        'tr',
        {},
        h(doc, 'th', { text: PANEL.chartMinute, attrs: { scope: 'col' } }),
        h(doc, 'th', { text: PANEL.clicks, attrs: { scope: 'col' } }),
      ),
    ),
    h(
      doc,
      'tbody',
      {},
      ...bars.map((bar) =>
        h(
          doc,
          'tr',
          {},
          h(doc, 'th', { text: formatMinute(bar.startSec, timeZone), attrs: { scope: 'row' } }),
          h(doc, 'td', { text: String(bar.clicks) }),
        ),
      ),
    ),
  );

  setChildren(container, svg, legend, table);
}
