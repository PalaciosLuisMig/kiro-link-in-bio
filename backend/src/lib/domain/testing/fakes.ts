// In-memory doubles of every domain port, for tests only.
//
// Production code must never import this module: the doubles live under
// `domain/testing/` and are referenced only from `*.test.ts` and from the
// reusable contract battery (`repository-contract.ts`). They satisfy the SAME
// contracts as the real adapters (task 9), including the 24 h TTL of events and
// connections and the atomic one-time consumption of a ticket, so a use-case
// test against a double behaves like one against DynamoDB.
//
// This file is under `backend/src/lib/domain/`, so it is pure domain code: no
// AWS, no Node, no DOM imports. It mirrors the storage math (`ttl = ts/1000 +
// 86400`) without any AWS SDK, exactly as the design prescribes.

import type { MetricsSnapshot } from '@link-in-bio/shared';

import type {
  Channel,
  Connection,
  Link,
  MetricsItem,
  StoredEvent,
  StoredLink,
} from '../entities.js';
import { NotFound, ValidationError } from '../errors.js';
import type {
  Clock,
  IdGenerator,
  LinkPatch,
  LinkRepository,
  LogContext,
  Logger,
  MetricsRepository,
  EventRepository,
  OnlyLogContext,
  OwnerTokenProvider,
  RandomSource,
  RealtimeAccessRepository,
  RealtimeNotifier,
  SendResult,
} from '../ports.js';

/** Seconds added to an event or connection timestamp for its 24 h TTL. */
export const TTL_SECONDS = 86_400;

/** Milliseconds in one second, for the ms -> Unix-seconds TTL conversion. */
const MS_PER_SECOND = 1000;

/**
 * Computes the TTL (Unix seconds) an adapter stores for an event or connection:
 * `floor(tsMs / 1000) + 86400`. Exported so the contract battery can assert the
 * doubles match the design's rule without duplicating the literal.
 */
export function ttlFromMs(tsMs: number): number {
  return Math.floor(tsMs / MS_PER_SECOND) + TTL_SECONDS;
}

// --- Deterministic infrastructure doubles -----------------------------------

/**
 * A controllable {@link Clock}. `now()` returns a value the test sets, and
 * `sleep(ms)` does not wait for real time: it advances the clock by `ms` and
 * resolves on the next microtask, so time-dependent code runs fast and
 * deterministically. `advance` lets a test move time forward explicitly.
 */
export class FakeClock implements Clock {
  private current: number;
  /** Every `sleep` duration requested, in call order, for assertions. */
  readonly sleeps: number[] = [];

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    // Advancing on sleep models elapsed time without a real timer, so a padding
    // loop like notify-panel's terminates deterministically.
    this.current += ms;
    await Promise.resolve();
  }

  /** Sets the current time (Unix ms). */
  set(ms: number): void {
    this.current = ms;
  }

  /** Moves the current time forward by `ms`. */
  advance(ms: number): void {
    this.current += ms;
  }
}

/**
 * A deterministic sequential {@link IdGenerator}: `prefix-1`, `prefix-2`, ...
 * Predictable ids make it trivial to assert which link or event was created.
 */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = 'id') {}

  next(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }
}

/**
 * A deterministic {@link RandomSource}. It returns bytes from a fixed seed
 * sequence (0, 1, 2, ... wrapping at 256), so `issueTicket` produces the same
 * ticket every run and a test can assert the exact value.
 */
export class DeterministicRandomSource implements RandomSource {
  private cursor = 0;

  constructor(private readonly seed = 0) {
    this.cursor = seed;
  }

  bytes(size: number): Uint8Array {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
      out[i] = (this.cursor + i) % 256;
    }
    this.cursor = (this.cursor + size) % 256;
    return out;
  }
}

/**
 * A {@link Logger} double that records every call instead of writing to a
 * console. Tests assert WHAT was logged (that the event feed failure was logged
 * on a best-effort path) and, through the closed {@link LogContext} type, the
 * compiler already guarantees no forbidden field can be passed.
 */
export class RecordingLogger implements Logger {
  readonly infos: { message: string; context?: LogContext }[] = [];
  readonly errors: { message: string; context?: LogContext }[] = [];

  info<T extends LogContext>(message: string, context?: OnlyLogContext<T>): void {
    this.infos.push(context === undefined ? { message } : { message, context });
  }

  error<T extends LogContext>(message: string, context?: OnlyLogContext<T>): void {
    this.errors.push(context === undefined ? { message } : { message, context });
  }
}

// --- Failure injection ------------------------------------------------------

/**
 * A toggle a test can arm to make the next (or every) call to a double fail,
 * so use cases can be tested on their failure paths (a failing event `put`, a
 * failing `removeLinkCounter`, a failing notifier `send`). `armOnce` fails the
 * next call only; `arm` fails every call until `disarm`.
 */
export class FailureSwitch {
  private remaining = 0;
  private forever = false;

  /** Arms a single failure on the next call. */
  armOnce(): void {
    this.remaining += 1;
  }

  /** Arms a failure on every call until `disarm`. */
  arm(): void {
    this.forever = true;
  }

  /** Clears all armed failures. */
  disarm(): void {
    this.remaining = 0;
    this.forever = false;
  }

  /** Returns `true` and consumes one armed failure when a call should fail. */
  shouldFail(): boolean {
    if (this.forever) {
      return true;
    }
    if (this.remaining > 0) {
      this.remaining -= 1;
      return true;
    }
    return false;
  }
}

// --- Repository doubles ------------------------------------------------------

/**
 * In-memory {@link LinkRepository}. Stores links by id and mirrors the
 * conditional semantics of the real adapter: `create` rejects a duplicate id,
 * `update` rejects a missing link with `NotFound`, and `reorder` rejects
 * anything other than an exact permutation of the existing ids with a
 * `ValidationError` (Requirement 6.13). The per-link click count comes from an
 * injected reader so a {@link Link} returned here carries the same `clicks` the
 * metrics double holds, as the DynamoDB adapter joins the two items.
 *
 * `removeLinkCounter` is modelled on {@link InMemoryMetricsRepository}, not
 * here, because the counter lives in the metrics item; `removeCounterFailure`
 * is therefore armed on the metrics double.
 */
export class InMemoryLinkRepository implements LinkRepository {
  private readonly links = new Map<string, StoredLink>();

  /**
   * @param clicksOf reads the current per-link click count (from the metrics
   * double), so `list`/`get` fill `Link.clicks` consistently.
   */
  constructor(private readonly clicksOf: (id: string) => number = () => 0) {}

  private toLink(stored: StoredLink): Link {
    return { ...stored, clicks: this.clicksOf(stored.id) };
  }

  async list(): Promise<Link[]> {
    return [...this.links.values()].map((stored) => this.toLink(stored));
  }

  async get(id: string): Promise<Link | null> {
    const stored = this.links.get(id);
    return stored === undefined ? null : this.toLink(stored);
  }

  async create(link: StoredLink): Promise<void> {
    if (this.links.has(link.id)) {
      // Mirrors the `attribute_not_exists(pk)` condition failing.
      throw new ValidationError('link already exists', ['id']);
    }
    this.links.set(link.id, link);
  }

  async update(id: string, patch: LinkPatch): Promise<Link> {
    const stored = this.links.get(id);
    if (stored === undefined) {
      // Mirrors the `attribute_exists(pk)` condition failing.
      throw new NotFound('link not found');
    }
    const updated: StoredLink = {
      ...stored,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    };
    this.links.set(id, updated);
    return this.toLink(updated);
  }

  async remove(id: string): Promise<void> {
    this.links.delete(id);
  }

  async reorder(orderedIds: readonly string[]): Promise<void> {
    const existing = [...this.links.keys()];
    if (!isExactPermutation(existing, orderedIds)) {
      // Mirrors a cancelled TransactWriteItems -> ValidationError (6.13).
      throw new ValidationError('ids are not an exact permutation', ['ids']);
    }
    orderedIds.forEach((id, index) => {
      const stored = this.links.get(id)!;
      this.links.set(id, { ...stored, position: index });
    });
  }

  /** Test helper: seed a stored link directly, bypassing the create condition. */
  seed(link: StoredLink): void {
    this.links.set(link.id, link);
  }
}

/** True when `candidate` is an exact permutation of `base` (same multiset). */
function isExactPermutation(base: readonly string[], candidate: readonly string[]): boolean {
  if (base.length !== candidate.length) {
    return false;
  }
  const remaining = new Map<string, number>();
  for (const id of base) {
    remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }
  for (const id of candidate) {
    const count = remaining.get(id);
    if (count === undefined || count === 0) {
      return false;
    }
    remaining.set(id, count - 1);
  }
  return true;
}

/**
 * In-memory {@link MetricsRepository}. The item is a flat attribute bag, exactly
 * what `parseMetricsItem` expects, and `recordClick`/`recordVisit` apply the
 * same `ADD` increments the real adapter builds. `reset` replaces the bag with
 * `{ epoch: now }`. `removeLinkCounter` deletes only the `l#<id>` attribute,
 * leaving totals, minutes and channels intact (Requirement 6.5).
 *
 * The `removeCounterFailure` switch makes `removeLinkCounter` reject, so the
 * `removeLink` use case can be tested on the best-effort branch where the link
 * is gone but its counter could not be cleared.
 */
export class InMemoryMetricsRepository implements MetricsRepository {
  private item: Record<string, unknown> = {};
  /** Arm to make `removeLinkCounter` fail (best-effort branch of removeLink). */
  readonly removeCounterFailure = new FailureSwitch();

  private add(name: string): void {
    const current = this.item[name];
    this.item[name] = (typeof current === 'number' ? current : 0) + 1;
  }

  async recordClick(linkId: string, channel: Channel, minuteSec: number): Promise<void> {
    this.add('totalClicks');
    this.add(`l#${linkId}`);
    this.add(`cc#${channel}`);
    this.add(`m#${minuteSec}`);
  }

  async recordVisit(channel: Channel): Promise<void> {
    this.add('totalVisits');
    this.add(`cv#${channel}`);
  }

  async read(): Promise<MetricsItem> {
    // Return a shallow copy so a caller cannot mutate the stored item.
    return { ...this.item };
  }

  async reset(now: number): Promise<void> {
    this.item = { epoch: now };
  }

  async removeLinkCounter(linkId: string): Promise<void> {
    if (this.removeCounterFailure.shouldFail()) {
      throw new Error('simulated removeLinkCounter failure');
    }
    delete this.item[`l#${linkId}`];
  }

  /** Test helper: read the current per-link counter (for the link double join). */
  clicksOf(linkId: string): number {
    const value = this.item[`l#${linkId}`];
    return typeof value === 'number' ? value : 0;
  }
}

/**
 * In-memory {@link EventRepository}. Each stored event records the `ttl` the
 * real adapter would compute (`ts/1000 + 86400`) and a 13-digit, zero-padded
 * sort key (`<ts>#<id>`), so `latest` can filter by a `sinceSortKey` floor and
 * order newest-first exactly like a DynamoDB `Query` with `ScanIndexForward:
 * false`. An event whose `ttl` has already passed is NOT returned even before
 * it would be deleted (Requirement 11.8), matching the adapter's age filter.
 *
 * `putFailure` makes the next (or every) `put` reject, so `registerClick` /
 * `registerVisit` can be tested on the best-effort branch where the counter is
 * already incremented but the feed entry could not be stored (Requirement 9.3).
 */
export class InMemoryEventRepository implements EventRepository {
  private readonly stored: StoredEntry[] = [];
  /** Arm to make `put` fail (best-effort feed-write branch). */
  readonly putFailure = new FailureSwitch();

  async put(event: StoredEvent): Promise<void> {
    if (this.putFailure.shouldFail()) {
      throw new Error('simulated event put failure');
    }
    this.stored.push({
      event,
      sortKey: eventSortKey(event.ts, event.id),
      ttl: ttlFromMs(event.ts),
    });
  }

  async latest(sinceSortKey: string, limit: number): Promise<StoredEvent[]> {
    return this.stored
      .filter((entry) => entry.sortKey > sinceSortKey)
      .sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0))
      .slice(0, limit)
      .map((entry) => entry.event);
  }

  /** Test helper: the TTL stored for the event with the given id, or undefined. */
  ttlOf(eventId: string): number | undefined {
    return this.stored.find((entry) => entry.event.id === eventId)?.ttl;
  }

  /** Test helper: the number of stored events. */
  get size(): number {
    return this.stored.length;
  }
}

/** One stored event plus the derived sort key and TTL the adapter would set. */
interface StoredEntry {
  readonly event: StoredEvent;
  readonly sortKey: string;
  readonly ttl: number;
}

/** Digits used to zero-pad the millisecond timestamp in an event sort key. */
const EVENT_TS_DIGITS = 13;

/**
 * Builds the event sort key `<ts,13 digits>#<id>` the design uses, so string
 * comparison orders events chronologically and the age/epoch floor is a single
 * string comparison. Exported so `getMetrics` and its tests build the same key.
 */
export function eventSortKey(tsMs: number, id: string): string {
  return `${String(tsMs).padStart(EVENT_TS_DIGITS, '0')}#${id}`;
}

/**
 * In-memory {@link RealtimeAccessRepository}. Tickets are stored by hash with
 * their expiry; `consumeTicket` is atomic: it deletes the ticket and returns
 * `true` only if it existed and `expiresAt > now`, so the SAME ticket can be
 * consumed AT MOST ONCE even across interleaved calls, and a boundary
 * `now === expiresAt` is rejected (Requirements 5.7, 5.16). Connections carry a
 * 24 h TTL, and `listConnections` returns only those not yet expired at `now`
 * (`ttl > now`, Requirement 11.6).
 */
export class InMemoryRealtimeAccessRepository implements RealtimeAccessRepository {
  private readonly tickets = new Map<string, number>(); // hash -> expiresAt (ms)
  private readonly connections = new Map<string, StoredConnection>();

  async storeTicket(hash: string, expiresAt: number): Promise<void> {
    this.tickets.set(hash, expiresAt);
  }

  async consumeTicket(hash: string, now: number): Promise<boolean> {
    const expiresAt = this.tickets.get(hash);
    if (expiresAt === undefined) {
      return false; // unknown or already used
    }
    // Deleting first makes the consumption atomic for this single-threaded
    // double: a second call for the same hash finds nothing, so it can never
    // succeed twice, even if the ticket had not expired.
    this.tickets.delete(hash);
    // Reject an expired ticket; `now === expiresAt` counts as expired.
    return expiresAt > now;
  }

  async addConnection(connection: Connection): Promise<void> {
    this.connections.set(connection.connectionId, {
      connection,
      ttl: ttlFromMs(connection.createdAt),
    });
  }

  async removeConnection(connectionId: string): Promise<void> {
    this.connections.delete(connectionId);
  }

  async listConnections(now: number): Promise<Connection[]> {
    const nowSeconds = Math.floor(now / MS_PER_SECOND);
    return [...this.connections.values()]
      .filter((entry) => entry.ttl > nowSeconds)
      .map((entry) => entry.connection);
  }

  /** Test helper: whether a ticket hash is still pending (not consumed/used). */
  hasTicket(hash: string): boolean {
    return this.tickets.has(hash);
  }
}

/** One stored connection plus the TTL (Unix seconds) the adapter would set. */
interface StoredConnection {
  readonly connection: Connection;
  readonly ttl: number;
}

/**
 * In-memory {@link OwnerTokenProvider}. Returns a configurable token so
 * `authorizeOwner` can be tested for the valid token, a wrong token, and the
 * misconfigured (short) token that must win with a 500.
 */
export class InMemoryOwnerTokenProvider implements OwnerTokenProvider {
  constructor(private token: string) {}

  async getToken(): Promise<string> {
    return this.token;
  }

  /** Test helper: change the configured token (e.g. to a short one). */
  set(token: string): void {
    this.token = token;
  }
}

/**
 * In-memory {@link RealtimeNotifier}. Records every payload sent and reports a
 * connection as `'gone'` when its id has been marked gone, so `notifyPanels`
 * can be tested for deletion on 410 and for continuing past other failures.
 * `sendFailure` makes `send` reject (a non-`gone` failure), which the caller
 * must log and skip (Requirement 12.6).
 */
export class InMemoryRealtimeNotifier implements RealtimeNotifier {
  readonly sent: { connectionId: string; payload: MetricsSnapshot }[] = [];
  private readonly goneIds = new Set<string>();
  /** Arm to make `send` reject with a non-`gone` error. */
  readonly sendFailure = new FailureSwitch();

  async send(connectionId: string, payload: MetricsSnapshot): Promise<SendResult> {
    if (this.sendFailure.shouldFail()) {
      throw new Error('simulated notifier send failure');
    }
    if (this.goneIds.has(connectionId)) {
      return 'gone';
    }
    this.sent.push({ connectionId, payload });
    return 'sent';
  }

  /** Test helper: mark a connection id so the next `send` to it returns `gone`. */
  markGone(connectionId: string): void {
    this.goneIds.add(connectionId);
  }
}
