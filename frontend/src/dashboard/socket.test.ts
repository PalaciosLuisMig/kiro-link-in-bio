import { describe, expect, test } from 'vitest';

import { createBrowserSocket, type WebSocketConstructor } from './socket.js';

// Tests of the adapter from the browser's WebSocket to the client's own interface.

class FakeBrowserSocket {
  static last: FakeBrowserSocket;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeBrowserSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

const Ctor = FakeBrowserSocket as unknown as WebSocketConstructor;

describe('createBrowserSocket', () => {
  test('opens the given URL', () => {
    createBrowserSocket('wss://example.test/prod?ticket=t', Ctor);
    expect(FakeBrowserSocket.last.url).toBe('wss://example.test/prod?ticket=t');
  });

  test('passes open, close and error through to whoever listens', () => {
    const like = createBrowserSocket('wss://x', Ctor);
    const seen: string[] = [];
    like.onopen = () => seen.push('open');
    like.onclose = () => seen.push('close');
    like.onerror = () => seen.push('error');

    FakeBrowserSocket.last.onopen?.(new Event('open'));
    FakeBrowserSocket.last.onerror?.(new Event('error'));
    FakeBrowserSocket.last.onclose?.({} as CloseEvent);
    expect(seen).toEqual(['open', 'error', 'close']);
  });

  test('hands over only the data of a message', () => {
    const like = createBrowserSocket('wss://x', Ctor);
    let received: unknown;
    like.onmessage = (event) => {
      received = event;
    };
    FakeBrowserSocket.last.onmessage?.({ data: 'hello', origin: 'x' } as unknown as MessageEvent);
    expect(received).toEqual({ data: 'hello' });
  });

  test('does nothing when nobody has set a listener yet', () => {
    createBrowserSocket('wss://x', Ctor);
    expect(() => {
      FakeBrowserSocket.last.onopen?.(new Event('open'));
      FakeBrowserSocket.last.onmessage?.({ data: 'x' } as MessageEvent);
      FakeBrowserSocket.last.onclose?.({} as CloseEvent);
    }).not.toThrow();
  });

  test('send and close go to the real socket', () => {
    const like = createBrowserSocket('wss://x', Ctor);
    like.send('{"type":"keepalive"}');
    like.close();
    expect(FakeBrowserSocket.last.sent).toEqual(['{"type":"keepalive"}']);
    expect(FakeBrowserSocket.last.closed).toBe(true);
  });
});
