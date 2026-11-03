// Domain ports for Link in Bio (hexagonal architecture).
//
// A port is an interface the domain OWNS and the adapters (task 9) implement.
// The use cases receive ports as injected dependencies, so they never import
// the AWS SDK, Node, or the adapters; the composition roots wire the real
// implementations, and the in-memory doubles (see `testing/`) satisfy the same
// contracts in tests. This file is the single source of truth for those
// contracts.
//
// This module is pure domain logic: no AWS, no Node, no DOM imports. It imports
// only TypeScript types (from `shared/` and from the sibling domain modules),
// which the ESLint domain boundary allows.
//
// The signatures below cover the use cases of tasks 5, 6 and 7. Where the
// design does not pin a method name or shape, the choice is documented inline
// as an assumption so a later task can revisit it deliberately.

import type { MetricsSnapshot } from '@link-in-bio/shared';

import type {
  Channel,
  Connection,
  Link,
  MetricsItem,
  StoredEvent,
  StoredLink,
} from './entities.js';

// --- Logger -----------------------------------------------------------------
//
// The `Logger` port is deliberately the narrowest port in the system. Its type
// must make it IMPOSSIBLE, at compile time, to log a request body, headers, the
// owner token, or a connection ticket (Requirements 5.18, 11.2). We achieve
// that with a CLOSED context type: an interface with EXACTLY the allowed fields
// and an index signature of `never`, not `Record<string, unknown>`. Any extra
// property is therefore a type error, so `logger.info('route', { token })`
// cannot compile.

/**
 * The only fields allowed in a log entry.
 *
 * - `code`: the stable error code (one of `ERROR_CODES`) or a short event code.
 * - `route`: the API route name, e.g. `/api/clicks` (never a full URL with a
 *   query string, which could carry a ticket).
 * - `requestId`: the Lambda invocation / request id, a technical identifier.
 *
 * This is the allowed SHAPE. On its own, TypeScript's structural typing would
 * let an object with extra properties satisfy it, so the forbidding of extra
 * fields is enforced at the call site by {@link Logger}'s generic methods, not
 * by an index signature here (an index signature of `never` is incompatible
 * with these optional string fields).
 */
export interface LogContext {
  readonly code?: string;
  readonly route?: string;
  readonly requestId?: string;
}

/**
 * Compile-time guard that rejects any property of `T` not present in
 * {@link LogContext}.
 *
 * For every extra key, it maps the type to `never`, so passing `token`, `body`,
 * `headers`, or `ticket` makes the argument un-assignable and fails to compile.
 * Known keys are passed through unchanged. This is the mechanism that makes it
 * IMPOSSIBLE to log a forbidden field (Requirements 5.18, 11.2).
 */
export type OnlyLogContext<T> = LogContext & {
  readonly [K in keyof T]: K extends keyof LogContext ? T[K] : never;
};

/**
 * Structured logger limited to the allowed fields of {@link LogContext}.
 *
 * Both methods are generic so the context is checked for EXCESS keys via
 * {@link OnlyLogContext}: only `code`, `route` and `requestId` are accepted, and
 * any other field (a body, headers, the token, a ticket) is a type error. The
 * message is a short static string chosen by the caller, never interpolated
 * user input. This port is the ONLY way the domain "logs" anything; its Node
 * implementation (task 9.4) is the single place in the backend allowed to touch
 * `console`.
 */
export interface Logger {
  /** Logs an informational event with only the allowed fields. */
  info<T extends LogContext>(message: string, context?: OnlyLogContext<T>): void;
  /** Logs an error event with only the allowed fields. */
  error<T extends LogContext>(message: string, context?: OnlyLogContext<T>): void;
}

// --- Repositories -----------------------------------------------------------

/**
 * Persistence of the managed links (`LINKS` items).
 *
 * `list` returns every link (active and inactive) with its current `clicks`,
 * which `listPublicLinks`, `createLink` (to count toward the max of 10) and the
 * admin view all build on. `create` and `update` are CONDITIONAL on the design:
 * `create` on `attribute_not_exists(pk)` and `update` on `attribute_exists(pk)`
 * so neither recreates a phantom link. `reorder` performs the transactional
 * position rewrite (`TransactWriteItems`), which the adapter translates a
 * cancelled transaction into a `ValidationError` (Requirement 6.13).
 *
 * `removeLink` is split into two steps on purpose (Requirement 6.5): `remove`
 * deletes the `LINKS` item, and `removeLinkCounter` deletes the orphan `l#<id>`
 * counter from the metrics item afterwards. Keeping them separate lets the use
 * case succeed when the link is gone even if clearing the counter fails (the
 * counter is then filtered out by `getMetrics`).
 */
export interface LinkRepository {
  /** All links (active and inactive), each with its current click count. */
  list(): Promise<Link[]>;
  /** One link by id, or `null` when it does not exist. */
  get(id: string): Promise<Link | null>;
  /** Creates a link, conditional on `attribute_not_exists(pk)`. */
  create(link: StoredLink): Promise<void>;
  /**
   * Updates an existing link's title, url and/or active flag, conditional on
   * `attribute_exists(pk)`. Rejects with `NotFound` when the link is gone.
   * Never touches id, position, or the click counter.
   */
  update(id: string, patch: LinkPatch): Promise<Link>;
  /** Deletes the `LINKS` item (the per-link counter is removed separately). */
  remove(id: string): Promise<void>;
  /**
   * Rewrites positions to match `orderedIds` in a single transaction, each
   * update conditional on the link existing. A cancelled transaction surfaces
   * as `ValidationError` (Requirement 6.13).
   */
  reorder(orderedIds: readonly string[]): Promise<void>;
}

/** The mutable fields of a link, all optional (at least one is supplied). */
export interface LinkPatch {
  readonly title?: string;
  readonly url?: string;
  readonly active?: boolean;
}

/**
 * Persistence of the single metrics item (`METRICS / CURRENT`).
 *
 * `recordClick` and `recordVisit` are the atomic `ADD` increments: one
 * `UpdateItem` bumping all counters at once (Requirement 2.7), so a click adds
 * `totalClicks`, `l#<id>`, `cc#<channel>` and `m#<minuteSec>` together, and a
 * visit adds `totalVisits` and `cv#<channel>`. The caller supplies the already
 * normalized channel and the Minute start (Unix seconds) from the pure
 * `metrics.ts` helpers. `read` returns the raw item for `parseMetricsItem`.
 * `reset` replaces the item with an empty one carrying the new `epoch`
 * (Requirement 16.3). `removeLinkCounter` deletes the orphan `l#<id>` attribute
 * without touching totals, minutes, or channels (Requirement 6.5).
 */
export interface MetricsRepository {
  /** Atomically increments the four click counters in one operation. */
  recordClick(linkId: string, channel: Channel, minuteSec: number): Promise<void>;
  /** Atomically increments the two visit counters in one operation. */
  recordVisit(channel: Channel): Promise<void>;
  /** Reads the raw metrics item for `parseMetricsItem`. */
  read(): Promise<MetricsItem>;
  /** Replaces the metrics item with an empty one carrying `epoch = now`. */
  reset(now: number): Promise<void>;
  /** Removes the orphan `l#<id>` counter; totals and other counters unchanged. */
  removeLinkCounter(linkId: string): Promise<void>;
}

/**
 * Persistence of the activity-feed events (`EVENTS` items).
 *
 * `put` stores one event. The adapter derives the sort key from `ts` and `id`
 * and computes the `ttl` as `ts/1000 + 86400` (24 h); the domain supplies only
 * the {@link StoredEvent} fields. `latest` returns the newest events first,
 * reading only those whose sort key is strictly greater than an age/epoch floor
 * so an expired event is never returned even before DynamoDB deletes it
 * (Requirement 11.8). `sinceSortKey` is that inclusive-exclusive floor, built
 * by `getMetrics` from `max(epoch, now - 24h)` using the 13-digit timestamp
 * convention.
 */
export interface EventRepository {
  /** Stores one activity event (best effort; failure is logged, not fatal). */
  put(event: StoredEvent): Promise<void>;
  /** The newest `limit` events with a sort key strictly greater than the floor. */
  latest(sinceSortKey: string, limit: number): Promise<StoredEvent[]>;
}

/**
 * Persistence of the real-time access artifacts: one-time tickets (`TICKET`)
 * and open Panel connections (`CONN`).
 *
 * `storeTicket` persists only the SHA-256 hash of the ticket with its 60 s
 * expiry (Requirement 5.15). `consumeTicket` is the heart of the one-time
 * guarantee: a single atomic conditional delete that succeeds only if the
 * ticket exists and `expiresAt > now`, returning `true` exactly once so two
 * simultaneous connections with the same ticket cannot both succeed
 * (Requirements 5.7, 5.16); `now === expiresAt` is rejected. `addConnection`
 * and `removeConnection` manage the `CONN` items, and `listConnections` returns
 * only the non-expired ones (`ttl > now`), so `notifyPanels` never sends to a
 * stale connection (Requirement 11.6).
 */
export interface RealtimeAccessRepository {
  /** Stores the ticket hash with its expiry (Unix ms). */
  storeTicket(hash: string, expiresAt: number): Promise<void>;
  /**
   * Atomically consumes the ticket: deletes it and returns `true` only if it
   * existed and had not expired at `now`. Returns `false` otherwise, and never
   * succeeds twice for the same ticket.
   */
  consumeTicket(hash: string, now: number): Promise<boolean>;
  /** Records an open Panel connection with a 24 h TTL. */
  addConnection(connection: Connection): Promise<void>;
  /** Removes a connection (on `$disconnect`). */
  removeConnection(connectionId: string): Promise<void>;
  /** The connections that have not expired at `now` (`ttl > now`). */
  listConnections(now: number): Promise<Connection[]>;
}

// --- Other outbound ports ---------------------------------------------------

/**
 * Supplies the configured owner token (from SSM Parameter Store in production).
 *
 * `authorizeOwner` reads it to compare against the token in an admin request.
 * A value shorter than 32 characters means the server is misconfigured and
 * every admin request must fail with 500 (Requirement 5.5).
 */
export interface OwnerTokenProvider {
  /** The configured owner token. */
  getToken(): Promise<string>;
}

/** The outcome of sending a message to one connection. */
export type SendResult = 'sent' | 'gone';

/**
 * Pushes a snapshot to one Panel connection (API Gateway Management API in
 * production).
 *
 * `send` returns `'gone'` when the connection is closed (HTTP 410) so
 * `notifyPanels` can delete it, and `'sent'` on success (Requirement 12.7).
 * Any other failure rejects, so the caller can log it and continue with the
 * rest (Requirement 12.6).
 */
export interface RealtimeNotifier {
  /** Sends `payload` to `connectionId`; `'gone'` means the connection is closed. */
  send(connectionId: string, payload: MetricsSnapshot): Promise<SendResult>;
}

/**
 * Clock port: the single source of "now" and of waiting.
 *
 * Injecting it keeps the use cases deterministic and lets `notify-panel` pad an
 * invocation to at least 1 s (Requirement 8.7) through `sleep`. Time is Unix
 * milliseconds, matching `Date.now()`.
 */
export interface Clock {
  /** The current time in Unix milliseconds. */
  now(): number;
  /** Resolves after at least `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
}

/**
 * Generates unique identifiers (UUID v4 in production).
 *
 * Used for link ids and for the technical id of an activity event. Injecting it
 * makes id generation deterministic in tests.
 */
export interface IdGenerator {
  /** A fresh unique identifier. */
  next(): string;
}

/**
 * Source of cryptographically random bytes (Node `randomBytes` in production).
 *
 * `issueTicket` draws 32 bytes from it (Requirement 5.15). Injecting it makes
 * the ticket deterministic in tests.
 */
export interface RandomSource {
  /** Returns `size` random bytes. */
  bytes(size: number): Uint8Array;
}
