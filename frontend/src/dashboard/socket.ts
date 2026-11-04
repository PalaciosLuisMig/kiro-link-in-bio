// Adapter from the browser's `WebSocket` to the `WebSocketLike` the client uses.
//
// The client only needs to know when the socket opened, what text arrived, and that
// it closed or failed. Wrapping the real object, instead of casting it, keeps the
// client free of DOM event types and lets tests use a plain fake.

import type { WebSocketLike } from './realtime.js';

/** The part of the `WebSocket` constructor this adapter calls. */
export type WebSocketConstructor = new (url: string) => {
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  send(data: string): void;
  close(): void;
};

/** Opens `url` and returns it as a {@link WebSocketLike}. */
export function createBrowserSocket(
  url: string,
  Socket: WebSocketConstructor = WebSocket,
): WebSocketLike {
  const socket = new Socket(url);

  const like: WebSocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => socket.send(data),
    close: () => socket.close(),
  };

  socket.onopen = (event) => like.onopen?.(event);
  socket.onmessage = (event) => like.onmessage?.({ data: event.data });
  socket.onclose = (event) => like.onclose?.(event);
  socket.onerror = (event) => like.onerror?.(event);

  return like;
}
