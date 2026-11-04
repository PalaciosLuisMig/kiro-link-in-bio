// DynamoDB adapters for the four persistence ports, over the single
// `LinkInBioTable`.
//
// This module is in the ADAPTERS layer, so it may depend on the AWS SDK
// (`structure.md`). It is the ONLY place that sends DynamoDB commands: it wraps
// an injected `DynamoDBDocumentClient` and turns each port method into a send of
// a command built by the PURE builders of task 9.1 (`dynamodb-expressions.ts`),
// wrapping the conditional sends with the PURE error mapping of task 9.2
// (`dynamodb-errors.ts`). It holds no business logic of its own: the "what" is
// in the domain, the "how to phrase it for DynamoDB" is in 9.1, the "what an
// SDK failure means" is in 9.2, and this file only performs the I/O.
//
// DocumentClient marshalling requirement: the client MUST be created with
// `marshallOptions.removeUndefinedValues: true`. A Visit event has no `title`
// (Requirement 11.1), and leaving an `undefined` attribute on a `PutCommand`
// item otherwise makes the DocumentClient throw. The composition root (task 9.4
// / the handlers' roots) builds the client that way; `createDocumentClient`
// below centralises the correct configuration so every root and the tests build
// it identically.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import type {
  Channel,
  Connection,
  Link,
  MetricsItem,
  StoredEvent,
  StoredLink,
} from '../domain/entities.js';
import { ERROR_REASONS } from '@link-in-bio/shared';

import { ValidationError } from '../domain/errors.js';
import type {
  EventRepository,
  LinkPatch,
  LinkRepository,
  MetricsRepository,
  RealtimeAccessRepository,
} from '../domain/ports.js';

import {
  isConditionalCheckFailed,
  mapReorderError,
  mapUpdateLinkError,
} from './dynamodb-errors.js';
import {
  buildClickUpdate,
  buildConsumeTicketDelete,
  buildCreateLinkPut,
  buildLatestEventsQuery,
  buildPutEventPut,
  buildRemoveLinkCounterUpdate,
  buildReorderTransaction,
  buildResetMetricsPut,
  buildStoreTicketPut,
  buildUpdateLinkUpdate,
  buildVisitUpdate,
  linkSortKey,
  METRICS_SORT_KEY,
  PARTITION,
  PK,
  SK,
  TTL_ATTRIBUTE,
} from './dynamodb-expressions.js';

/** Milliseconds in one second, for the ms -> Unix-seconds conversions. */
const MS_PER_SECOND = 1000;

/** Seconds added to a connection timestamp for its 24 h TTL. */
const CONNECTION_TTL_SECONDS = 86_400;

/**
 * Creates a {@link DynamoDBDocumentClient} configured the single correct way for
 * this project: `removeUndefinedValues: true` so a Visit event (no `title`) can
 * be put without an explicit `undefined` attribute throwing (Requirement 11.1).
 *
 * The composition roots call this; keeping it here guarantees every root and the
 * adapters agree on the marshalling contract the adapters rely on.
 *
 * @param base An optional low-level client (the composition root may pass one
 *   with a region/credentials); a default is created when omitted.
 */
export function createDocumentClient(base?: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(base ?? new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/** Reads the `l#<id>` counter for `id` off a raw metrics item (0 when absent). */
function clicksOf(item: MetricsItem, id: string): number {
  const value = item[`l#${id}`];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
 * DynamoDB-backed {@link LinkRepository}.
 *
 * `list` and `get` JOIN the `LINKS` item(s) with the metrics item's `l#<id>`
 * counters so a returned {@link Link} carries its current `clicks` (the counter
 * lives in the metrics item, not on the link item). Both reads are strongly
 * consistent, matching the design's consistent reads for admin views. `create`,
 * `update` and `reorder` are the conditional writes of 9.1, with `update` and
 * `reorder` failures translated by 9.2 into `NotFound`/`ValidationError`.
 */
export class DynamoDbLinkRepository implements LinkRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** Reads the metrics item once (consistently) for the per-link click join. */
  private async readMetrics(): Promise<MetricsItem> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [PK]: PARTITION.metrics, [SK]: METRICS_SORT_KEY },
        ConsistentRead: true,
      }),
    );
    return (result.Item ?? {}) as MetricsItem;
  }

  /**
   * Turns a stored `LINKS` item into a {@link Link}, joining its `clicks` from
   * the raw metrics item's `l#<id>` counter.
   */
  private toLink(item: Record<string, unknown>, metrics: MetricsItem): Link {
    const id = String(item['id']);
    return {
      id,
      title: String(item['title']),
      url: String(item['url']),
      position: Number(item['position']),
      active: Boolean(item['active']),
      clicks: clicksOf(metrics, id),
      createdAt: Number(item['createdAt']),
    };
  }

  async list(): Promise<Link[]> {
    const metrics = await this.readMetrics();
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': PK },
        ExpressionAttributeValues: { ':pk': PARTITION.links },
        ConsistentRead: true,
      }),
    );
    const items = result.Items ?? [];
    return items.map((item) => this.toLink(item, metrics));
  }

  async get(id: string): Promise<Link | null> {
    const metrics = await this.readMetrics();
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [PK]: PARTITION.links, [SK]: linkSortKey(id) },
        ConsistentRead: true,
      }),
    );
    if (result.Item === undefined) {
      return null;
    }
    return this.toLink(result.Item, metrics);
  }

  async create(link: StoredLink): Promise<void> {
    await this.client.send(new PutCommand(buildCreateLinkPut(this.tableName, link)));
  }

  async update(id: string, patch: LinkPatch): Promise<Link> {
    let updated: Record<string, unknown>;
    try {
      const result = await this.client.send(
        new UpdateCommand(buildUpdateLinkUpdate(this.tableName, id, patch)),
      );
      updated = result.Attributes ?? {};
    } catch (error) {
      // A failed `attribute_exists(pk)` means the link is gone -> NotFound.
      mapUpdateLinkError(error);
    }
    // `mapUpdateLinkError` always throws, so reaching here means success.
    return this.toLink(updated, await this.readMetrics());
  }

  async remove(id: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { [PK]: PARTITION.links, [SK]: linkSortKey(id) },
      }),
    );
  }

  async reorder(orderedIds: readonly string[]): Promise<void> {
    // The port contract requires a non-permutation to reject with a
    // `ValidationError` (Requirement 6.13). A `TransactWriteItems` only catches
    // SOME non-permutations on its own (a missing id fails `attribute_exists`,
    // and a duplicated id is a duplicate-key cancellation), but an order that
    // simply omits an existing id would otherwise succeed and silently leave
    // that link behind. So we verify the exact permutation against the current
    // links first, matching the in-memory double, and only then send the
    // transaction (whose own conditional guards a concurrent delete, which the
    // 9.2 mapping turns into a `ValidationError` too).
    const existingIds = (await this.list()).map((link) => link.id);
    if (!isExactPermutation(existingIds, orderedIds)) {
      throw new ValidationError(
        'ids are not an exact permutation of the existing links',
        ['ids'],
        ERROR_REASONS.idsNotPermutation,
      );
    }
    try {
      await this.client.send(
        new TransactWriteCommand(buildReorderTransaction(this.tableName, orderedIds)),
      );
    } catch (error) {
      // A cancelled transaction (a link vanished) -> ValidationError (6.13).
      mapReorderError(error);
    }
  }
}

/**
 * DynamoDB-backed {@link MetricsRepository}.
 *
 * `recordClick`/`recordVisit` send the atomic `ADD` updates of 9.1, `read`
 * fetches the raw item for `parseMetricsItem` (strongly consistent so a reset or
 * a fresh increment is reflected), `reset` overwrites the item with the new
 * epoch, and `removeLinkCounter` drops a single orphan `l#<id>` attribute.
 */
export class DynamoDbMetricsRepository implements MetricsRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async recordClick(linkId: string, channel: Channel, minuteSec: number): Promise<void> {
    await this.client.send(
      new UpdateCommand(buildClickUpdate(this.tableName, linkId, channel, minuteSec)),
    );
  }

  async recordVisit(channel: Channel): Promise<void> {
    await this.client.send(new UpdateCommand(buildVisitUpdate(this.tableName, channel)));
  }

  async read(): Promise<MetricsItem> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [PK]: PARTITION.metrics, [SK]: METRICS_SORT_KEY },
        ConsistentRead: true,
      }),
    );
    return (result.Item ?? {}) as MetricsItem;
  }

  async reset(now: number): Promise<void> {
    await this.client.send(new PutCommand(buildResetMetricsPut(this.tableName, now)));
  }

  async removeLinkCounter(linkId: string): Promise<void> {
    await this.client.send(new UpdateCommand(buildRemoveLinkCounterUpdate(this.tableName, linkId)));
  }
}

/**
 * DynamoDB-backed {@link EventRepository}.
 *
 * `put` stores one event (the client's `removeUndefinedValues` drops the absent
 * `title` of a Visit event). `latest` queries the `EVENTS` partition newest
 * first with the age/epoch floor and the `ttl > now` filter of 9.1, then maps
 * each item back to a {@link StoredEvent}.
 */
export class DynamoDbEventRepository implements EventRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly now: () => number,
  ) {}

  async put(event: StoredEvent): Promise<void> {
    await this.client.send(new PutCommand(buildPutEventPut(this.tableName, event)));
  }

  async latest(sinceSortKey: string, limit: number): Promise<StoredEvent[]> {
    const nowSec = Math.floor(this.now() / MS_PER_SECOND);
    const result = await this.client.send(
      new QueryCommand(buildLatestEventsQuery(this.tableName, sinceSortKey, nowSec, limit)),
    );
    const items = result.Items ?? [];
    return items.map((item) => toStoredEvent(item));
  }
}

/** Turns a stored `EVENTS` item back into a {@link StoredEvent}. */
function toStoredEvent(item: Record<string, unknown>): StoredEvent {
  const base: StoredEvent = {
    id: String(item['id']),
    type: item['type'] as StoredEvent['type'],
    channel: String(item['channel']),
    ts: Number(item['ts']),
  };
  // A Visit event has no title; include it only when present.
  return item['title'] === undefined ? base : { ...base, title: String(item['title']) };
}

/**
 * DynamoDB-backed {@link RealtimeAccessRepository}.
 *
 * `storeTicket` persists only the ticket hash with its expiry. `consumeTicket`
 * sends the atomic conditional delete of 9.1 and translates a
 * `ConditionalCheckFailedException` into `false` (not consumed: expired, used,
 * or missing) via 9.2; any other error propagates. `addConnection` /
 * `removeConnection` manage the `CONN` items, and `listConnections` queries the
 * partition and keeps only connections whose `ttl` is strictly greater than now
 * (Requirement 11.6), matching the age filter the design relies on even before
 * DynamoDB deletes an expired item.
 */
export class DynamoDbRealtimeAccessRepository implements RealtimeAccessRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async storeTicket(hash: string, expiresAt: number): Promise<void> {
    await this.client.send(new PutCommand(buildStoreTicketPut(this.tableName, hash, expiresAt)));
  }

  async consumeTicket(hash: string, now: number): Promise<boolean> {
    try {
      await this.client.send(
        new DeleteCommand(buildConsumeTicketDelete(this.tableName, hash, now)),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return false;
      }
      throw error;
    }
  }

  async addConnection(connection: Connection): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          [PK]: PARTITION.connections,
          [SK]: connection.connectionId,
          connectionId: connection.connectionId,
          createdAt: connection.createdAt,
          [TTL_ATTRIBUTE]:
            Math.floor(connection.createdAt / MS_PER_SECOND) + CONNECTION_TTL_SECONDS,
        },
      }),
    );
  }

  async removeConnection(connectionId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { [PK]: PARTITION.connections, [SK]: connectionId },
      }),
    );
  }

  async listConnections(now: number): Promise<Connection[]> {
    const nowSec = Math.floor(now / MS_PER_SECOND);
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#pk = :pk',
        FilterExpression: '#ttl > :now',
        ExpressionAttributeNames: { '#pk': PK, '#ttl': TTL_ATTRIBUTE },
        ExpressionAttributeValues: { ':pk': PARTITION.connections, ':now': nowSec },
        ConsistentRead: true,
      }),
    );
    const items = result.Items ?? [];
    return items.map((item) => ({
      connectionId: String(item['connectionId']),
      createdAt: Number(item['createdAt']),
    }));
  }
}
