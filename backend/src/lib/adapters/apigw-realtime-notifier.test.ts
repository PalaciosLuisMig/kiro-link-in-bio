import { PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import type { PostToConnectionCommandOutput } from '@aws-sdk/client-apigatewaymanagementapi';
import type { MetricsSnapshot } from '@link-in-bio/shared';
import { parse } from '@link-in-bio/shared';
import { describe, expect, test } from 'vitest';

import type { PostToConnectionSend } from './apigw-realtime-notifier.js';
import { ApiGatewayRealtimeNotifier } from './apigw-realtime-notifier.js';

// Tests for the API Gateway Management notifier (task 9.4), driven by a FAKE
// client. They assert the 410 -> 'gone' translation (by exception name and by
// $metadata status), the 'sent' success path with a well-formed snapshot
// message, and that any other error rejects (so notifyPanels logs and continues).

/** A minimal metrics snapshot for the payload. */
const SNAPSHOT: MetricsSnapshot = {
  epoch: 0,
  serverTime: '2024-01-01T00:00:00.000Z',
  totals: { clicks: 3, visits: 5 },
  links: { 'link-1': 3 },
  minutes: { '2024-01-01T00:00:00.000Z': 3 },
  channels: { directo: { clicks: 3, visits: 5 } },
  events: [],
};

/** An AWS-SDK-shaped error identified by its `name`, like the real SDK. */
function sdkError(name: string): Error {
  const error = new Error(`fake ${name}`);
  error.name = name;
  return error;
}

/** A fake client whose `send` runs a scripted behaviour and records inputs. */
class FakeManagementClient implements PostToConnectionSend {
  readonly inputs: Array<PostToConnectionCommand['input']> = [];

  constructor(private readonly behaviour: () => Promise<PostToConnectionCommandOutput>) {}

  async send(command: PostToConnectionCommand): Promise<PostToConnectionCommandOutput> {
    this.inputs.push(command.input);
    return this.behaviour();
  }
}

describe('ApiGatewayRealtimeNotifier', () => {
  test('returns "sent" and posts a well-formed snapshot message on success', async () => {
    const client = new FakeManagementClient(async () => ({ $metadata: {} }));
    const notifier = new ApiGatewayRealtimeNotifier(client);

    const result = await notifier.send('conn-1', SNAPSHOT);

    expect(result).toBe('sent');
    expect(client.inputs).toHaveLength(1);
    expect(client.inputs[0]?.ConnectionId).toBe('conn-1');

    // The payload is the serialized `snapshot` message the Panel expects.
    const data = client.inputs[0]?.Data;
    const text = typeof data === 'string' ? data : String(data);
    const parsed = parse(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.type).toBe('snapshot');
      expect(parsed.value.totals).toEqual({ clicks: 3, visits: 5 });
    }
  });

  test('translates a GoneException into "gone"', async () => {
    const client = new FakeManagementClient(async () => {
      throw sdkError('GoneException');
    });
    const notifier = new ApiGatewayRealtimeNotifier(client);

    await expect(notifier.send('conn-closed', SNAPSHOT)).resolves.toBe('gone');
  });

  test('translates a 410 $metadata status into "gone"', async () => {
    const client = new FakeManagementClient(async () => {
      const error = new Error('gone') as Error & {
        $metadata: { httpStatusCode: number };
      };
      error.$metadata = { httpStatusCode: 410 };
      throw error;
    });
    const notifier = new ApiGatewayRealtimeNotifier(client);

    await expect(notifier.send('conn-closed', SNAPSHOT)).resolves.toBe('gone');
  });

  test('rethrows any other error', async () => {
    const client = new FakeManagementClient(async () => {
      throw sdkError('LimitExceededException');
    });
    const notifier = new ApiGatewayRealtimeNotifier(client);

    await expect(notifier.send('conn-1', SNAPSHOT)).rejects.toThrow('LimitExceededException');
  });
});
