import { describe, expect, test } from 'vitest';

import type { StoredEvent, StoredLink } from '../domain/entities.js';
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
  eventFloorSortKey,
  eventSortKey,
  linkSortKey,
  METRICS_SORT_KEY,
  PARTITION,
  PK,
  SK,
  TTL_ATTRIBUTE,
} from './dynamodb-expressions.js';

// Tests for the pure DynamoDB command-input builders (task 9.1). They assert
// the shape the real adapters (task 9.3) will send: the exact counters an ADD
// touches, every dynamic attribute name routed through ExpressionAttributeNames,
// the conditions the design prescribes, and the keys of each item.

const TABLE = 'LinkInBioTable';

/**
 * Resolves an `UpdateExpression`/`ConditionExpression` through its
 * `ExpressionAttributeNames`, returning the set of REAL attribute names a given
 * expression references. Lets a test assert "the ADD touches exactly these four
 * counters" without depending on the placeholder spelling (`#a0`, `#a1`, ...).
 */
function resolvedNames(expression: string, names: Record<string, string> | undefined): Set<string> {
  const resolved = new Set<string>();
  for (const [placeholder, actual] of Object.entries(names ?? {})) {
    if (expression.includes(placeholder)) {
      resolved.add(actual);
    }
  }
  return resolved;
}

describe('buildClickUpdate', () => {
  test('is a single ADD touching exactly the four click counters', () => {
    const input = buildClickUpdate(TABLE, 'link-1', 'instagram', 1_700_000_040);

    expect(input.TableName).toBe(TABLE);
    expect(input.Key).toEqual({ [PK]: PARTITION.metrics, [SK]: METRICS_SORT_KEY });
    expect(input.UpdateExpression?.startsWith('ADD ')).toBe(true);

    // Exactly the four counters, resolved through ExpressionAttributeNames.
    expect(resolvedNames(input.UpdateExpression ?? '', input.ExpressionAttributeNames)).toEqual(
      new Set(['totalClicks', 'l#link-1', 'cc#instagram', 'm#1700000040']),
    );
  });

  test('routes every counter name through ExpressionAttributeNames (none inlined)', () => {
    const input = buildClickUpdate(TABLE, 'link-1', 'instagram', 1_700_000_040);

    // No real counter name (with its `#`) appears literally in the expression;
    // only placeholders do.
    for (const counter of ['totalClicks', 'l#link-1', 'cc#instagram', 'm#1700000040']) {
      expect(input.UpdateExpression).not.toContain(counter);
    }
    // Four distinct name placeholders and four value placeholders, each +1.
    expect(Object.keys(input.ExpressionAttributeNames ?? {})).toHaveLength(4);
    expect(Object.values(input.ExpressionAttributeValues ?? {})).toEqual([1, 1, 1, 1]);
  });

  test('keeps a channel with a hyphen safe inside a name placeholder', () => {
    const input = buildClickUpdate(TABLE, 'id', 'otro-x', 1_700_000_040);
    expect(resolvedNames(input.UpdateExpression ?? '', input.ExpressionAttributeNames)).toContain(
      'cc#otro-x',
    );
    expect(input.UpdateExpression).not.toContain('otro-x');
  });
});

describe('buildVisitUpdate', () => {
  test('is a single ADD touching exactly the two visit counters', () => {
    const input = buildVisitUpdate(TABLE, 'tiktok');

    expect(input.Key).toEqual({ [PK]: PARTITION.metrics, [SK]: METRICS_SORT_KEY });
    expect(input.UpdateExpression?.startsWith('ADD ')).toBe(true);
    expect(resolvedNames(input.UpdateExpression ?? '', input.ExpressionAttributeNames)).toEqual(
      new Set(['totalVisits', 'cv#tiktok']),
    );
    expect(Object.values(input.ExpressionAttributeValues ?? {})).toEqual([1, 1]);
  });
});

describe('buildResetMetricsPut', () => {
  test('replaces METRICS/CURRENT with only the new epoch and no condition', () => {
    const input = buildResetMetricsPut(TABLE, 1_700_000_000_000);
    expect(input.Item).toEqual({
      [PK]: PARTITION.metrics,
      [SK]: METRICS_SORT_KEY,
      epoch: 1_700_000_000_000,
    });
    expect(input.ConditionExpression).toBeUndefined();
  });
});

describe('buildRemoveLinkCounterUpdate', () => {
  test('REMOVEs only the orphan l#<id> counter, via a name placeholder', () => {
    const input = buildRemoveLinkCounterUpdate(TABLE, 'link-9');
    expect(input.Key).toEqual({ [PK]: PARTITION.metrics, [SK]: METRICS_SORT_KEY });
    expect(resolvedNames(input.UpdateExpression ?? '', input.ExpressionAttributeNames)).toEqual(
      new Set(['l#link-9']),
    );
    expect(input.UpdateExpression?.startsWith('REMOVE')).toBe(true);
    expect(input.ConditionExpression).toBeUndefined();
  });
});

describe('buildCreateLinkPut', () => {
  const link: StoredLink = {
    id: 'link-1',
    title: 'My link',
    url: 'https://example.com/',
    position: 0,
    active: true,
    createdAt: 1_700_000_000_000,
  };

  test('is a conditional Put guarded by attribute_not_exists on pk', () => {
    const input = buildCreateLinkPut(TABLE, link);

    expect(input.Item?.[PK]).toBe(PARTITION.links);
    expect(input.Item?.[SK]).toBe(linkSortKey('link-1'));
    expect(input.ConditionExpression).toBe('attribute_not_exists(#pk)');
    const pkPlaceholder = (input.ExpressionAttributeNames ?? {})['#pk'];
    expect(pkPlaceholder).toBe(PK);
  });

  test('stores the link fields but never a clicks counter', () => {
    const input = buildCreateLinkPut(TABLE, link);
    expect(input.Item).toMatchObject({
      id: 'link-1',
      title: 'My link',
      url: 'https://example.com/',
      position: 0,
      active: true,
      createdAt: 1_700_000_000_000,
    });
    expect(input.Item).not.toHaveProperty('clicks');
  });
});

describe('buildUpdateLinkUpdate', () => {
  test('is guarded by attribute_exists on pk', () => {
    const input = buildUpdateLinkUpdate(TABLE, 'link-1', { title: 'New' });
    expect(input.Key).toEqual({ [PK]: PARTITION.links, [SK]: linkSortKey('link-1') });
    expect(input.ConditionExpression).toBe('attribute_exists(#pk)');
  });

  test('sets ONLY the fields provided', () => {
    const input = buildUpdateLinkUpdate(TABLE, 'link-1', { active: false });
    const referenced = resolvedNames(input.UpdateExpression ?? '', input.ExpressionAttributeNames);
    expect(referenced.has('active')).toBe(true);
    expect(referenced.has('title')).toBe(false);
    expect(referenced.has('url')).toBe(false);
    expect(Object.values(input.ExpressionAttributeValues ?? {})).toEqual([false]);
  });

  test('sets every provided field when all three are present', () => {
    const input = buildUpdateLinkUpdate(TABLE, 'link-1', {
      title: 'T',
      url: 'https://example.com/',
      active: true,
    });
    const referenced = resolvedNames(input.UpdateExpression ?? '', input.ExpressionAttributeNames);
    expect(referenced).toEqual(new Set(['title', 'url', 'active']));
    expect(input.UpdateExpression?.startsWith('SET ')).toBe(true);
  });

  test('throws when no field is provided', () => {
    expect(() => buildUpdateLinkUpdate(TABLE, 'link-1', {})).toThrow();
  });
});

describe('buildReorderTransaction', () => {
  test('yields one conditional Update per id with position = index', () => {
    const ids = ['a', 'b', 'c'];
    const input = buildReorderTransaction(TABLE, ids);
    expect(input.TransactItems).toHaveLength(3);

    input.TransactItems?.forEach((item, index) => {
      const update = item.Update;
      expect(update?.Key).toEqual({ [PK]: PARTITION.links, [SK]: linkSortKey(ids[index] ?? '') });
      expect(update?.ConditionExpression).toBe('attribute_exists(#pk)');
      expect(update?.ExpressionAttributeValues?.[':position']).toBe(index);
      expect(
        resolvedNames(update?.UpdateExpression ?? '', update?.ExpressionAttributeNames),
      ).toContain('position');
    });
  });

  test('an empty order yields no transaction items', () => {
    expect(buildReorderTransaction(TABLE, []).TransactItems).toHaveLength(0);
  });
});

describe('buildPutEventPut', () => {
  test('stores a click event with its title and a 24h TTL', () => {
    const event: StoredEvent = {
      id: 'evt-1',
      type: 'click',
      channel: 'qr',
      title: 'My link',
      ts: 1_700_000_000_000,
    };
    const input = buildPutEventPut(TABLE, event);
    expect(input.Item?.[PK]).toBe(PARTITION.events);
    expect(input.Item?.[SK]).toBe(eventSortKey(event.ts, event.id));
    expect(input.Item?.title).toBe('My link');
    // TTL is ts/1000 + 86400.
    expect(input.Item?.[TTL_ATTRIBUTE]).toBe(1_700_000_000 + 86_400);
  });

  test('omits title for a visit event', () => {
    const event: StoredEvent = {
      id: 'evt-2',
      type: 'visit',
      channel: 'directo',
      ts: 1_700_000_000_000,
    };
    const input = buildPutEventPut(TABLE, event);
    expect(input.Item).not.toHaveProperty('title');
  });
});

describe('buildLatestEventsQuery', () => {
  test('reads EVENTS newest-first above the floor with a ttl filter', () => {
    const floor = eventFloorSortKey(1_700_000_000_000);
    const input = buildLatestEventsQuery(TABLE, floor, 1_700_000_000, 20);
    expect(input.ExpressionAttributeValues?.[':pk']).toBe(PARTITION.events);
    expect(input.ExpressionAttributeValues?.[':floor']).toBe(floor);
    expect(input.ExpressionAttributeValues?.[':now']).toBe(1_700_000_000);
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(20);
    expect(input.ConsistentRead).toBe(true);
  });
});

describe('buildStoreTicketPut', () => {
  test('stores only the hash, the expiry and a 1h safety-net TTL', () => {
    const input = buildStoreTicketPut(TABLE, 'deadbeef', 1_700_000_060_000);
    expect(input.Item).toEqual({
      [PK]: PARTITION.tickets,
      [SK]: 'deadbeef',
      expiresAt: 1_700_000_060_000,
      [TTL_ATTRIBUTE]: 1_700_000_060 + 3_600,
    });
  });
});

describe('buildConsumeTicketDelete', () => {
  test('deletes only when it exists and expiresAt > now (now === expiresAt rejected)', () => {
    const input = buildConsumeTicketDelete(TABLE, 'deadbeef', 1_700_000_060_000);
    expect(input.Key).toEqual({ [PK]: PARTITION.tickets, [SK]: 'deadbeef' });
    expect(input.ConditionExpression).toBe('attribute_exists(#pk) AND #expiresAt > :now');
    // Strict `>`: an equal `now` does not satisfy the condition (single-use at the boundary).
    expect(input.ConditionExpression).toContain('>');
    expect(input.ConditionExpression).not.toContain('>=');
    expect(input.ExpressionAttributeValues?.[':now']).toBe(1_700_000_060_000);
    expect(input.ExpressionAttributeNames?.['#expiresAt']).toBe('expiresAt');
    expect(input.ReturnValues).toBe('ALL_OLD');
  });
});
