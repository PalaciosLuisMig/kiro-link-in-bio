// Pure builders for the DynamoDB command inputs of the single `LinkInBioTable`.
//
// This module is in the ADAPTERS layer, so it is allowed to depend on the AWS
// SDK (`structure.md`), but it only imports TYPES from `@aws-sdk/lib-dynamodb`
// and `@aws-sdk/client-dynamodb`: every function here is PURE. It builds the
// plain command-input objects (`UpdateCommandInput`, `PutCommandInput`,
// `DeleteCommandInput`, `TransactWriteCommandInput`, `QueryCommandInput`) that
// the DocumentClient commands accept, and performs NO I/O and NO client calls.
// The real adapters (task 9.3) create a DocumentClient and send these inputs;
// task 9.2 tests these builders directly, which is why they take the table name
// and the domain values as parameters and return the input unchanged.
//
// Expression-attribute-name rule (task 9.1): EVERY attribute name that carries
// a `#` or a `-` MUST be referenced through `ExpressionAttributeNames`, never
// inlined into an expression string, because `#` and `-` are not valid in a
// DynamoDB expression identifier. We go further and route the dynamically named
// counters (`l#<id>`, `cc#<channel>`, `cv#<channel>`, `m#<minuteSec>`) through
// names as well, so a channel like `otro-x` or an id with any character can
// never break the expression. Values always go through
// `ExpressionAttributeValues`.
//
// Single-table key conventions (design "Data Models"):
//   LINKS    pk=`LINKS`    sk=`LINK#<id>`
//   METRICS  pk=`METRICS`  sk=`CURRENT`
//   EVENTS   pk=`EVENTS`   sk=`<ts ms, 13 digits>#<id>`
//   CONN     pk=`CONN`     sk=`<connectionId>`
//   TICKET   pk=`TICKET`   sk=`<sha-256 hex>`

import type {
  DeleteCommandInput,
  PutCommandInput,
  QueryCommandInput,
  TransactWriteCommandInput,
  UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';

import type { StoredEvent, StoredLink } from '../domain/entities.js';
import type { CounterIncrement } from '../domain/metrics.js';
import { buildClickIncrement, buildVisitIncrement, EPOCH_ATTRIBUTE } from '../domain/metrics.js';

// --- Key attributes and partition values ------------------------------------

/** The partition-key attribute name. */
export const PK = 'pk';

/** The sort-key attribute name. */
export const SK = 'sk';

/** The TTL attribute name (Unix seconds) DynamoDB uses for auto-expiry. */
export const TTL_ATTRIBUTE = 'ttl';

/** Partition-key values, one per item type. */
export const PARTITION = {
  links: 'LINKS',
  metrics: 'METRICS',
  events: 'EVENTS',
  connections: 'CONN',
  tickets: 'TICKET',
} as const;

/** The constant sort key of the single metrics item (`METRICS / CURRENT`). */
export const METRICS_SORT_KEY = 'CURRENT';

/** Prefix of a link's sort key: `LINK#<id>`. */
const LINK_SORT_KEY_PREFIX = 'LINK#';

/** Seconds added to an event timestamp for its 24 h TTL. */
const EVENT_TTL_SECONDS = 86_400;

/** Seconds added to a ticket expiry for its 1 h safety-net TTL. */
const TICKET_TTL_SECONDS = 3_600;

/** Milliseconds in one second, for the ms -> Unix-seconds TTL conversion. */
const MS_PER_SECOND = 1000;

/** Width of the zero-padded 13-digit millisecond timestamp in an event sort key. */
const EVENT_TIMESTAMP_WIDTH = 13;

// --- Shared helpers ----------------------------------------------------------

/**
 * Builds the sort key of a link item from its id (`LINK#<id>`).
 *
 * Exported so task 9.3 and the tests derive the key the same way.
 */
export function linkSortKey(id: string): string {
  return `${LINK_SORT_KEY_PREFIX}${id}`;
}

/**
 * Builds the sort key of an activity event: the event time in milliseconds,
 * left-padded with zeros to 13 digits, then `#`, then the id.
 *
 * The fixed width makes the string sort order match the numeric time order, so
 * a `Query` with `ScanIndexForward = false` returns the newest events first and
 * an age/epoch floor can be expressed as a plain string comparison (design
 * "Data Models"; Requirement 9.1). Exported so `getMetrics` (task 6.2) can
 * build the `latest` floor with the same convention.
 *
 * @param tsMs Event time in Unix milliseconds.
 * @param id Technical event id.
 */
export function eventSortKey(tsMs: number, id: string): string {
  return `${String(tsMs).padStart(EVENT_TIMESTAMP_WIDTH, '0')}#${id}`;
}

/**
 * Builds the event-age floor sort key for a given millisecond timestamp: the
 * 13-digit padded time with no id suffix.
 *
 * Because every real event key is `<13 digits>#<id>` and `#` sorts after no
 * suffix, any event at or after `tsMs` compares strictly greater than this
 * floor. `latest` uses it as the exclusive lower bound (`sk > :floor`), so an
 * event exactly at the boundary millisecond is still returned.
 *
 * @param tsMs Floor time in Unix milliseconds (`max(epoch, now - 24h)`).
 */
export function eventFloorSortKey(tsMs: number): string {
  return String(tsMs).padStart(EVENT_TIMESTAMP_WIDTH, '0');
}

/**
 * Turns a millisecond timestamp into the Unix-seconds TTL stored on an item:
 * `floor(tsMs / 1000) + seconds`. Used for both the 24 h event TTL and the 1 h
 * ticket safety-net TTL.
 */
function ttlFromMs(tsMs: number, seconds: number): number {
  return Math.floor(tsMs / MS_PER_SECOND) + seconds;
}

/**
 * Builds an `ADD #a0 :v0, #a1 :v1, ...` update for a {@link CounterIncrement},
 * routing EVERY counter name through `ExpressionAttributeNames` (they carry `#`
 * and may carry `-` inside a channel) and every amount through
 * `ExpressionAttributeValues`.
 *
 * Each counter gets a positional placeholder (`#a0`, `:v0`, ...) so no attribute
 * name or value is ever inlined into the expression string. The placeholders
 * are generated in `Object.entries` order, which is deterministic for the
 * string keys these increments use, keeping the output stable for the tests.
 */
function buildAddUpdate(
  tableName: string,
  key: Readonly<Record<string, string>>,
  increment: CounterIncrement,
): UpdateCommandInput {
  const names: Record<string, string> = {};
  const values: Record<string, number> = {};
  const assignments: string[] = [];

  let index = 0;
  for (const [attributeName, amount] of Object.entries(increment)) {
    const namePlaceholder = `#a${index}`;
    const valuePlaceholder = `:v${index}`;
    names[namePlaceholder] = attributeName;
    values[valuePlaceholder] = amount;
    assignments.push(`${namePlaceholder} ${valuePlaceholder}`);
    index += 1;
  }

  return {
    TableName: tableName,
    Key: key,
    UpdateExpression: `ADD ${assignments.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

// --- Metrics: atomic ADD increments ------------------------------------------

/**
 * Builds the single `UpdateItem` that records one Click: an atomic `ADD` that
 * bumps the four counters at once — `totalClicks`, `l#<linkId>`, `cc#<channel>`
 * and `m#<minuteSec>` — on the `METRICS / CURRENT` item (Requirements 2.5, 2.7,
 * 12.3). An `ADD` on a missing attribute creates it, so the item needs no prior
 * initialization.
 *
 * `channel` must already be normalized and `minuteSec` is a Minute start in Unix
 * seconds; the domain's `buildClickIncrement` supplies the exact attribute set.
 *
 * @param tableName The `LinkInBioTable` name.
 * @param linkId Id of the clicked link.
 * @param channel Already-normalized source channel.
 * @param minuteSec Minute start in Unix seconds.
 */
export function buildClickUpdate(
  tableName: string,
  linkId: string,
  channel: string,
  minuteSec: number,
): UpdateCommandInput {
  return buildAddUpdate(
    tableName,
    { [PK]: PARTITION.metrics, [SK]: METRICS_SORT_KEY },
    buildClickIncrement(linkId, channel, minuteSec),
  );
}

/**
 * Builds the single `UpdateItem` that records one Visit: an atomic `ADD` that
 * bumps the two visit counters at once — `totalVisits` and `cv#<channel>` — on
 * the `METRICS / CURRENT` item (Requirements 3.2, 12.3).
 *
 * @param tableName The `LinkInBioTable` name.
 * @param channel Already-normalized source channel.
 */
export function buildVisitUpdate(tableName: string, channel: string): UpdateCommandInput {
  return buildAddUpdate(
    tableName,
    { [PK]: PARTITION.metrics, [SK]: METRICS_SORT_KEY },
    buildVisitIncrement(channel),
  );
}

/**
 * Builds the `PutItem` that resets the metrics: it REPLACES `METRICS / CURRENT`
 * with an empty item carrying only the new `epoch`, which atomically clears
 * every counter in one write (Requirements 16.3, 16.7, 16.8). No condition: a
 * reset must overwrite whatever is there.
 *
 * @param tableName The `LinkInBioTable` name.
 * @param epochMs The new epoch (Unix ms), i.e. the reset time.
 */
export function buildResetMetricsPut(tableName: string, epochMs: number): PutCommandInput {
  return {
    TableName: tableName,
    Item: {
      [PK]: PARTITION.metrics,
      [SK]: METRICS_SORT_KEY,
      [EPOCH_ATTRIBUTE]: epochMs,
    },
  };
}

/**
 * Builds the `UpdateItem` that removes a single orphan per-link counter
 * (`l#<linkId>`) from the metrics item, leaving totals, minutes and channels
 * untouched (Requirement 6.5). The counter name carries `#`, so it goes through
 * `ExpressionAttributeNames`.
 *
 * No condition: removing a counter that is already gone is a no-op, which is the
 * desired best-effort behaviour after a link is deleted.
 *
 * @param tableName The `LinkInBioTable` name.
 * @param linkId Id whose `l#<id>` counter is removed.
 */
export function buildRemoveLinkCounterUpdate(
  tableName: string,
  linkId: string,
): UpdateCommandInput {
  return {
    TableName: tableName,
    Key: { [PK]: PARTITION.metrics, [SK]: METRICS_SORT_KEY },
    UpdateExpression: 'REMOVE #counter',
    ExpressionAttributeNames: { '#counter': `l#${linkId}` },
  };
}

// --- Links -------------------------------------------------------------------

/**
 * Builds the conditional `PutItem` that creates a link, guarded by
 * `attribute_not_exists(pk)` so it never overwrites an existing link or
 * recreates a phantom one (Requirement 6.1). The `pk` name is a plain
 * identifier, but it is routed through `ExpressionAttributeNames` for
 * uniformity and to stay safe if the key is ever renamed.
 *
 * The item stores only the {@link StoredLink} fields; `clicks` is NOT stored
 * here (it lives in the metrics item as `l#<id>`).
 *
 * @param tableName The `LinkInBioTable` name.
 * @param link The link fields to store.
 */
export function buildCreateLinkPut(tableName: string, link: StoredLink): PutCommandInput {
  return {
    TableName: tableName,
    Item: {
      [PK]: PARTITION.links,
      [SK]: linkSortKey(link.id),
      id: link.id,
      title: link.title,
      url: link.url,
      position: link.position,
      active: link.active,
      createdAt: link.createdAt,
    },
    ConditionExpression: 'attribute_not_exists(#pk)',
    ExpressionAttributeNames: { '#pk': PK },
  };
}

/** A link edit: the subset of mutable fields a `PATCH` supplies (at least one). */
export interface LinkEdit {
  readonly title?: string;
  readonly url?: string;
  readonly active?: boolean;
}

/**
 * Builds the conditional `UpdateItem` that edits a link, guarded by
 * `attribute_exists(pk)` so a `PATCH` on a deleted link fails (surfaced as
 * `NotFound`) instead of recreating it (Requirement 6.12). Only the fields
 * present in `edit` are set; `id`, `position` and the counter are never touched
 * (Requirement 6.3).
 *
 * The attribute names here (`title`, `url`, `active`) are plain identifiers, but
 * they are still routed through `ExpressionAttributeNames` because `url` is a
 * DynamoDB reserved word and `name`-like identifiers are safest as placeholders.
 *
 * @param tableName The `LinkInBioTable` name.
 * @param id Id of the link to edit.
 * @param edit The fields to set (at least one must be present).
 * @returns The update input.
 * @throws Error if `edit` has no fields (the caller validates this earlier).
 */
export function buildUpdateLinkUpdate(
  tableName: string,
  id: string,
  edit: LinkEdit,
): UpdateCommandInput {
  const names: Record<string, string> = { '#pk': PK };
  const values: Record<string, unknown> = {};
  const assignments: string[] = [];

  if (edit.title !== undefined) {
    names['#title'] = 'title';
    values[':title'] = edit.title;
    assignments.push('#title = :title');
  }
  if (edit.url !== undefined) {
    names['#url'] = 'url';
    values[':url'] = edit.url;
    assignments.push('#url = :url');
  }
  if (edit.active !== undefined) {
    names['#active'] = 'active';
    values[':active'] = edit.active;
    assignments.push('#active = :active');
  }

  if (assignments.length === 0) {
    throw new Error('buildUpdateLinkUpdate requires at least one field to set');
  }

  return {
    TableName: tableName,
    Key: { [PK]: PARTITION.links, [SK]: linkSortKey(id) },
    UpdateExpression: `SET ${assignments.join(', ')}`,
    ConditionExpression: 'attribute_exists(#pk)',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  };
}

/**
 * Builds the `TransactWriteItems` that reorders links: one conditional
 * `Update` per link that rewrites its `position` to its index in `orderedIds`,
 * each guarded by `attribute_exists(pk)` so a vanished link cancels the whole
 * transaction. A cancelled transaction is translated by task 9.3 into a
 * `ValidationError` (Requirement 6.13). Positions are renumbered 0..n-1 in the
 * order given (Requirement 6.4).
 *
 * `position` and `pk` are routed through `ExpressionAttributeNames` (per-item,
 * since each transaction item carries its own name/value maps).
 *
 * @param tableName The `LinkInBioTable` name.
 * @param orderedIds The link ids in their new order (an exact permutation of the
 *   existing ids, which the use case checks before calling).
 */
export function buildReorderTransaction(
  tableName: string,
  orderedIds: readonly string[],
): TransactWriteCommandInput {
  return {
    TransactItems: orderedIds.map((id, position) => ({
      Update: {
        TableName: tableName,
        Key: { [PK]: PARTITION.links, [SK]: linkSortKey(id) },
        UpdateExpression: 'SET #position = :position',
        ConditionExpression: 'attribute_exists(#pk)',
        ExpressionAttributeNames: { '#position': 'position', '#pk': PK },
        ExpressionAttributeValues: { ':position': position },
      },
    })),
  };
}

// --- Events ------------------------------------------------------------------

/**
 * Builds the `PutItem` that stores one activity event. The sort key encodes the
 * time (`eventSortKey`) and the item carries a 24 h TTL derived from `ts`
 * (`ts/1000 + 86400`); the domain supplies only the {@link StoredEvent} fields,
 * never a TTL and never any IP/User-Agent/Referer (Requirements 9.1, 11.1,
 * 11.8).
 *
 * A visit has no `title`, so `title` is included only when present; the real
 * client is created with `removeUndefinedValues: true` (task 9.3), but omitting
 * it here keeps the builder's output clean and testable.
 *
 * @param tableName The `LinkInBioTable` name.
 * @param event The event fields to store.
 */
export function buildPutEventPut(tableName: string, event: StoredEvent): PutCommandInput {
  const item: Record<string, unknown> = {
    [PK]: PARTITION.events,
    [SK]: eventSortKey(event.ts, event.id),
    id: event.id,
    type: event.type,
    channel: event.channel,
    ts: event.ts,
    [TTL_ATTRIBUTE]: ttlFromMs(event.ts, EVENT_TTL_SECONDS),
  };
  if (event.title !== undefined) {
    item.title = event.title;
  }
  return { TableName: tableName, Item: item };
}

/**
 * Builds the `Query` for the newest events of the current epoch window
 * (Requirements 7.1, 11.8). It reads the `EVENTS` partition newest-first
 * (`ScanIndexForward = false`), limited to `limit`, keeping only events whose
 * sort key is strictly greater than the age/epoch floor AND whose `ttl` is
 * strictly greater than `nowSec`, so an event that is logically expired is never
 * returned even before DynamoDB deletes it.
 *
 * The floor is passed as a value (`:floor`); `pk`, `sk` and `ttl` are reserved
 * or special enough to route through `ExpressionAttributeNames`.
 *
 * @param tableName The `LinkInBioTable` name.
 * @param floorSortKey Exclusive lower-bound sort key (`eventFloorSortKey` of
 *   `max(epoch, now - 24h)`).
 * @param nowSec Current time in Unix seconds, for the `ttl > :now` filter.
 * @param limit Maximum number of events to return (e.g. 20).
 */
export function buildLatestEventsQuery(
  tableName: string,
  floorSortKey: string,
  nowSec: number,
  limit: number,
): QueryCommandInput {
  return {
    TableName: tableName,
    KeyConditionExpression: '#pk = :pk AND #sk > :floor',
    FilterExpression: '#ttl > :now',
    ExpressionAttributeNames: { '#pk': PK, '#sk': SK, '#ttl': TTL_ATTRIBUTE },
    ExpressionAttributeValues: {
      ':pk': PARTITION.events,
      ':floor': floorSortKey,
      ':now': nowSec,
    },
    ScanIndexForward: false,
    Limit: limit,
    ConsistentRead: true,
  };
}

// --- Tickets -----------------------------------------------------------------

/**
 * Builds the `PutItem` that stores a pending one-time connection ticket: only
 * the SHA-256 hash is ever persisted, never the ticket itself (Requirement
 * 5.15). The item carries `expiresAt` (Unix ms) and a 1 h safety-net TTL
 * (`expiresAt/1000 + 3600`); validity is decided by `expiresAt`, not by the TTL.
 *
 * @param tableName The `LinkInBioTable` name.
 * @param hash SHA-256 hex hash of the ticket.
 * @param expiresAtMs Ticket expiry in Unix ms (60 s after issue).
 */
export function buildStoreTicketPut(
  tableName: string,
  hash: string,
  expiresAtMs: number,
): PutCommandInput {
  return {
    TableName: tableName,
    Item: {
      [PK]: PARTITION.tickets,
      [SK]: hash,
      expiresAt: expiresAtMs,
      [TTL_ATTRIBUTE]: ttlFromMs(expiresAtMs, TICKET_TTL_SECONDS),
    },
  };
}

/**
 * Builds the conditional `DeleteItem` that atomically consumes a ticket: it
 * deletes the ticket ONLY if it exists and has not expired at `nowMs`
 * (`expiresAt > :now`; `now === expiresAt` is rejected), and returns the old
 * item (`ReturnValues = ALL_OLD`). Because the delete is atomic, two
 * simultaneous connections with the same ticket cannot both succeed: exactly
 * one gets the condition, the other's `ConditionalCheckFailedException` means
 * "not consumed" (Requirements 5.7, 5.16).
 *
 * `expiresAt` is a plain identifier, routed through `ExpressionAttributeNames`
 * for uniformity, and `nowMs` is a value.
 *
 * @param tableName The `LinkInBioTable` name.
 * @param hash SHA-256 hex hash of the ticket to consume.
 * @param nowMs Current time in Unix ms.
 */
export function buildConsumeTicketDelete(
  tableName: string,
  hash: string,
  nowMs: number,
): DeleteCommandInput {
  return {
    TableName: tableName,
    Key: { [PK]: PARTITION.tickets, [SK]: hash },
    ConditionExpression: 'attribute_exists(#pk) AND #expiresAt > :now',
    ExpressionAttributeNames: { '#pk': PK, '#expiresAt': 'expiresAt' },
    ExpressionAttributeValues: { ':now': nowMs },
    ReturnValues: 'ALL_OLD',
  };
}
