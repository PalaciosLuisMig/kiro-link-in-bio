import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, test } from 'vitest';

import { runRepositoryContract } from '../domain/testing/repository-contract.js';

import {
  DynamoDbEventRepository,
  DynamoDbLinkRepository,
  DynamoDbMetricsRepository,
  DynamoDbRealtimeAccessRepository,
} from './dynamodb-repositories.js';

// Tests for the real DynamoDB adapters (task 9.3), run against a FAKE in-memory
// DocumentClient. The fake emulates just enough of DynamoDB to drive the
// `runRepositoryContract` battery (task 4) through the SAME adapters production
// uses: it stores items by `pk`/`sk`, honours the condition expressions the 9.1
// builders emit (`attribute_not_exists`/`attribute_exists` on `pk`,
// `expiresAt > :now`), performs the atomic `ADD`/`SET`/`REMOVE` updates,
// executes a `TransactWriteCommand` all-or-nothing, and answers a `Query`
// newest-first with the sort-key floor and the `ttl > :now` filter. When a
// condition fails it throws an error whose `.name` is the exact AWS SDK v3
// exception name, so the adapters' 9.2 error mapping is exercised for real.

const TABLE = 'LinkInBioTable';

/** A stored item, keyed by its `pk`/`sk`. */
type Item = Record<string, unknown>;

/** An AWS-SDK-shaped error: identified by its `name`, like the real SDK. */
function sdkError(name: string): Error {
  const error = new Error(`fake ${name}`);
  error.name = name;
  return error;
}

/** The composite key string the fake uses to index an item. */
function keyOf(pk: unknown, sk: unknown): string {
  return `${String(pk)}\u0000${String(sk)}`;
}

/**
 * A minimal in-memory DocumentClient. It accepts the real
 * `@aws-sdk/lib-dynamodb` command instances and reacts to their `input`,
 * emulating only the behaviours the contract battery relies on.
 */
class FakeDocumentClient {
  private readonly items = new Map<string, Item>();

  // The real client's `send` is overloaded; the adapters only ever pass the six
  // command types below, so a single `unknown`-typed method suffices here.
  async send(command: unknown): Promise<Record<string, unknown>> {
    if (command instanceof PutCommand) {
      return this.put(command.input);
    }
    if (command instanceof GetCommand) {
      return this.get(command.input);
    }
    if (command instanceof UpdateCommand) {
      return this.update(command.input);
    }
    if (command instanceof DeleteCommand) {
      return this.delete(command.input);
    }
    if (command instanceof QueryCommand) {
      return this.query(command.input);
    }
    if (command instanceof TransactWriteCommand) {
      return this.transact(command.input);
    }
    throw new Error(`FakeDocumentClient: unsupported command ${String(command)}`);
  }

  // --- Put -----------------------------------------------------------------

  private put(input: Record<string, unknown>): Record<string, unknown> {
    const item = input['Item'] as Item;
    const key = keyOf(item['pk'], item['sk']);
    const condition = input['ConditionExpression'] as string | undefined;
    if (condition === 'attribute_not_exists(#pk)' && this.items.has(key)) {
      throw sdkError('ConditionalCheckFailedException');
    }
    // A reset `Put` has no condition and must overwrite whatever is there.
    this.items.set(key, { ...item });
    return {};
  }

  // --- Get -----------------------------------------------------------------

  private get(input: Record<string, unknown>): Record<string, unknown> {
    const requestedKey = input['Key'] as Item;
    const key = keyOf(requestedKey['pk'], requestedKey['sk']);
    const item = this.items.get(key);
    return item === undefined ? {} : { Item: { ...item } };
  }

  // --- Update --------------------------------------------------------------

  private update(input: Record<string, unknown>): Record<string, unknown> {
    const requestedKey = input['Key'] as Item;
    const key = keyOf(requestedKey['pk'], requestedKey['sk']);
    const expression = input['UpdateExpression'] as string;
    const names = (input['ExpressionAttributeNames'] ?? {}) as Record<string, string>;
    const values = (input['ExpressionAttributeValues'] ?? {}) as Record<string, unknown>;
    const condition = input['ConditionExpression'] as string | undefined;

    if (condition === 'attribute_exists(#pk)' && !this.items.has(key)) {
      throw sdkError('ConditionalCheckFailedException');
    }

    // An `ADD` on a missing item creates it, matching DynamoDB.
    const existing = this.items.get(key) ?? { pk: requestedKey['pk'], sk: requestedKey['sk'] };
    const item: Item = { ...existing };

    if (expression.startsWith('ADD ')) {
      applyAdd(expression, names, values, item);
    } else if (expression.startsWith('SET ')) {
      applySet(expression, names, values, item);
    } else if (expression.startsWith('REMOVE ')) {
      applyRemove(expression, names, item);
    } else {
      throw new Error(`FakeDocumentClient: unsupported update ${expression}`);
    }

    this.items.set(key, item);
    return input['ReturnValues'] === 'ALL_NEW' ? { Attributes: { ...item } } : {};
  }

  // --- Delete --------------------------------------------------------------

  private delete(input: Record<string, unknown>): Record<string, unknown> {
    const requestedKey = input['Key'] as Item;
    const key = keyOf(requestedKey['pk'], requestedKey['sk']);
    const condition = input['ConditionExpression'] as string | undefined;

    if (condition === 'attribute_exists(#pk) AND #expiresAt > :now') {
      const values = (input['ExpressionAttributeValues'] ?? {}) as Record<string, unknown>;
      const now = values[':now'] as number;
      const item = this.items.get(key);
      // Fails if missing, or `expiresAt <= now` (strict `>`, boundary rejected).
      if (item === undefined || (item['expiresAt'] as number) <= now) {
        throw sdkError('ConditionalCheckFailedException');
      }
    }

    const old = this.items.get(key);
    this.items.delete(key);
    return input['ReturnValues'] === 'ALL_OLD' && old !== undefined ? { Attributes: old } : {};
  }

  // --- Query ---------------------------------------------------------------

  private query(input: Record<string, unknown>): Record<string, unknown> {
    const names = (input['ExpressionAttributeNames'] ?? {}) as Record<string, string>;
    const values = (input['ExpressionAttributeValues'] ?? {}) as Record<string, unknown>;
    const keyExpression = input['KeyConditionExpression'] as string;
    const filter = input['FilterExpression'] as string | undefined;
    const limit = input['Limit'] as number | undefined;
    const forward = (input['ScanIndexForward'] as boolean | undefined) ?? true;

    const pk = values[':pk'];
    let rows = [...this.items.values()].filter((item) => item['pk'] === pk);

    // The only sort-key condition the builders emit is `#sk > :floor`.
    if (keyExpression.includes('#sk > :floor')) {
      const floor = values[':floor'] as string;
      rows = rows.filter((item) => String(item['sk']) > floor);
    }

    // The only filters the builders emit are `#ttl > :now`.
    if (filter === '#ttl > :now') {
      const now = values[':now'] as number;
      const ttlName = names['#ttl'] ?? 'ttl';
      rows = rows.filter((item) => (item[ttlName] as number) > now);
    }

    rows.sort((a, b) => {
      const order =
        String(a['sk']) < String(b['sk']) ? -1 : String(a['sk']) > String(b['sk']) ? 1 : 0;
      return forward ? order : -order;
    });

    if (limit !== undefined) {
      rows = rows.slice(0, limit);
    }

    return { Items: rows.map((item) => ({ ...item })) };
  }

  // --- TransactWrite -------------------------------------------------------

  private transact(input: Record<string, unknown>): Record<string, unknown> {
    const transactItems = input['TransactItems'] as { Update: Record<string, unknown> }[];

    // All-or-nothing: validate every conditional update first, apply none on a
    // single failure, mirroring a cancelled transaction.
    for (const { Update } of transactItems) {
      const requestedKey = Update['Key'] as Item;
      const key = keyOf(requestedKey['pk'], requestedKey['sk']);
      const condition = Update['ConditionExpression'] as string | undefined;
      if (condition === 'attribute_exists(#pk)' && !this.items.has(key)) {
        throw sdkError('TransactionCanceledException');
      }
    }

    for (const { Update } of transactItems) {
      const requestedKey = Update['Key'] as Item;
      const key = keyOf(requestedKey['pk'], requestedKey['sk']);
      const names = (Update['ExpressionAttributeNames'] ?? {}) as Record<string, string>;
      const values = (Update['ExpressionAttributeValues'] ?? {}) as Record<string, unknown>;
      const item: Item = { ...(this.items.get(key) as Item) };
      applySet(Update['UpdateExpression'] as string, names, values, item);
      this.items.set(key, item);
    }
    return {};
  }
}

/** Applies an `ADD #a0 :v0, #a1 :v1, ...` update in place. */
function applyAdd(
  expression: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
  item: Item,
): void {
  const body = expression.slice('ADD '.length);
  for (const pair of body.split(', ')) {
    const [namePlaceholder = '', valuePlaceholder = ''] = pair.split(' ');
    const attribute = names[namePlaceholder] ?? namePlaceholder;
    const amount = values[valuePlaceholder] as number;
    const current = item[attribute];
    item[attribute] = (typeof current === 'number' ? current : 0) + amount;
  }
}

/** Applies a `SET #x = :x, ...` update in place. */
function applySet(
  expression: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
  item: Item,
): void {
  const body = expression.slice('SET '.length);
  for (const assignment of body.split(', ')) {
    const [left = '', right = ''] = assignment.split(' = ');
    const attribute = names[left.trim()] ?? left.trim();
    item[attribute] = values[right.trim()];
  }
}

/** Applies a `REMOVE #x` update in place (the builders remove one attribute). */
function applyRemove(expression: string, names: Record<string, string>, item: Item): void {
  const placeholder = expression.slice('REMOVE '.length).trim();
  delete item[names[placeholder] ?? placeholder];
}

// The adapters are typed against `DynamoDBDocumentClient`; the fake implements
// only the `send` surface they use, so a cast at the boundary is enough and
// keeps the test free of a real AWS client.
function makeRepositories() {
  const client =
    new FakeDocumentClient() as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  // A fixed "now" far in the future so the event `ttl > now` filter keeps the
  // contract's events (their 24 h TTL is well past the 2023 base timestamps,
  // and the contract never advances the clock past that window).
  const now = () => 1_700_000_100_000;
  return {
    links: new DynamoDbLinkRepository(client, TABLE),
    metrics: new DynamoDbMetricsRepository(client, TABLE),
    events: new DynamoDbEventRepository(client, TABLE, now),
    access: new DynamoDbRealtimeAccessRepository(client, TABLE),
  };
}

// Run the full shared battery against the real adapters over the fake client.
runRepositoryContract('DynamoDB adapters (fake client)', makeRepositories);

// A couple of adapter-specific checks beyond the shared contract.
describe('DynamoDB adapters: specifics', () => {
  test('LinkRepository.list joins the per-link click counters from the metrics item', async () => {
    const { links, metrics } = makeRepositories();
    await links.create({
      id: 'a',
      title: 'A',
      url: 'https://a.example',
      position: 0,
      active: true,
      createdAt: 1_700_000_000_000,
    });
    await metrics.recordClick('a', 'qr', 1_700_000_040);
    await metrics.recordClick('a', 'qr', 1_700_000_040);

    const all = await links.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.clicks).toBe(2);
  });

  test('EventRepository.put stores a visit event without a title', async () => {
    const { events } = makeRepositories();
    await events.put({ id: 'v1', type: 'visit', channel: 'qr', ts: 1_700_000_050_000 });

    const latest = await events.latest('0', 20);
    expect(latest).toHaveLength(1);
    expect(latest[0]?.id).toBe('v1');
    expect(latest[0]?.title).toBeUndefined();
  });

  test('listConnections filters out connections past their 24 h TTL', async () => {
    const { access } = makeRepositories();
    const createdAt = 1_700_000_000_000;
    await access.addConnection({ connectionId: 'c1', createdAt });

    expect((await access.listConnections(createdAt + 1000)).map((c) => c.connectionId)).toEqual([
      'c1',
    ]);
    // 25 h later: past the TTL, so filtered out.
    const past = createdAt + 25 * 60 * 60 * 1000;
    expect(await access.listConnections(past)).toEqual([]);
  });
});
