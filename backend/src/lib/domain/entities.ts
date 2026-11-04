// Pure domain entities for Link in Bio.
//
// These are the in-domain shapes that the use cases (tasks 5, 6, 7) and the
// output adapters (task 9) exchange through the ports. They mirror the single
// table of the design (`LinkInBioTable`) but carry only the domain-meaningful
// fields: the DynamoDB keys (`pk`/`sk`) and the storage concern of `ttl` are a
// detail of the DynamoDB adapter, never of the domain.
//
// This module is pure domain logic: no AWS, no Node, no DOM imports. It only
// imports a TypeScript type from `shared/` to stay aligned with the wire
// contract, which the ESLint domain boundary allows.

import type { ActivityEvent } from '@link-in-bio/shared';

/**
 * A managed link (`LINKS / LINK#<id>` in the table).
 *
 * `position` orders the links on the public page (ascending, starting at 0).
 * `active` controls whether the link is shown publicly. `clicks` is the current
 * per-link click counter (`l#<id>` in the metrics item), carried here so the
 * admin view and `getMetrics` filtering can read it without a second lookup;
 * the repository fills it in. `createdAt` is the creation time in Unix ms.
 */
export interface Link {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly position: number;
  readonly active: boolean;
  readonly clicks: number;
  readonly createdAt: number;
}

/**
 * The fields of a Link that are stored directly on the `LINKS` item. `clicks`
 * is intentionally excluded: it lives in the metrics item (`l#<id>`), not on the
 * link item, so a repository joins the two when it returns a {@link Link}.
 */
export type StoredLink = Omit<Link, 'clicks'>;

/**
 * The source channel of an event or a click. It is the already-normalized
 * value produced by `normalizeChannel`: one of the predefined channels,
 * `directo`, or `otro`.
 */
export type Channel = string;

/** The kind of an activity event. */
export type EventType = ActivityEvent['type'];

/**
 * An activity-feed event as the domain hands it to the {@link EventRepository}
 * (`EVENTS / <ts,13 digits>#<id>` in the table).
 *
 * The domain supplies only these fields; the adapter derives the sort key from
 * `ts` and `id` and computes the `ttl` as `ts/1000 + 86400` (24 h). `ts` is the
 * event time in Unix ms. `title` is present only for clicks (Requirement 9.3).
 * By construction there is NO field for IP, User-Agent, or Referer: privacy is
 * enforced by the shape itself (Requirements 11.1, 11.2).
 */
export interface StoredEvent {
  readonly id: string;
  readonly type: EventType;
  readonly channel: Channel;
  readonly title?: string;
  readonly ts: number;
}

/**
 * An open Panel WebSocket connection (`CONN / <connectionId>` in the table).
 *
 * `createdAt` is the Unix-ms time the connection opened; the adapter derives the
 * `ttl` as `createdAt/1000 + 86400` (24 h). `connectionId` is the API Gateway
 * connection id, a transient technical identifier that does not identify a
 * person and expires automatically (Requirement 11.6, product privacy).
 */
export interface Connection {
  readonly connectionId: string;
  readonly createdAt: number;
}

/**
 * The raw metrics item as stored in DynamoDB (`METRICS / CURRENT`): a flat bag
 * of attributes read by `parseMetricsItem`.
 *
 * It is the whole item including `epoch`, `totalClicks`, `totalVisits` and the
 * dynamically-named counters (`l#`, `cc#`, `cv#`, `m#`). The domain never reads
 * individual attributes off it directly; it passes the item to
 * `parseMetricsItem`, which ignores unknown attributes. Keeping it as an opaque
 * attribute bag is why the type is a record of `unknown`.
 */
export type MetricsItem = Readonly<Record<string, unknown>>;

/**
 * A pending one-time connection ticket (`TICKET / <sha256-hex>` in the table).
 *
 * Only the SHA-256 hash of the ticket is ever stored, never the ticket itself
 * (Requirement 5.15). `expiresAt` is the Unix-ms expiry (60 s after issue); the
 * adapter derives the item `ttl` as a safety net 1 h later (`expiresAt/1000 +
 * 3600`), but validity is decided by `expiresAt`, not by the DynamoDB TTL.
 */
export interface Ticket {
  readonly hash: string;
  readonly expiresAt: number;
}
