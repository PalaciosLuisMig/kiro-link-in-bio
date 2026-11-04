// HTTP and WebSocket server for LOCAL development (not deployed).
//
// It does what API Gateway does in AWS: turns a real request into the `routeKey`
// and parameters the handlers expect, and runs the WebSocket handshake, refusing it
// with a 401 when the one-time ticket is wrong. The handlers do the rest.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';

import { MAX_KEEPALIVE_BYTES, WS_TICKET_PARAM } from '@link-in-bio/shared';

import { jsonResponse } from '../lib/http/responses.js';
import type { HttpRequest, HttpResponse } from '../lib/http/types.js';

import {
  createLocalBackend,
  type LocalBackend,
  type LocalBackendOptions,
} from './local-backend.js';
import { matchRoute } from './routing.js';

/** The WebSocket path. The Vite dev server proxies it to this server. */
export const WS_PATH = '/ws';

/** A body bigger than this is refused before any handler sees it (the API limit is 10 KB). */
const MAX_REQUEST_BYTES = 1024 * 1024;

export interface LocalServer {
  readonly backend: LocalBackend;
  /** Starts listening; resolves with the port really used (useful with port 0). */
  listen(port: number, host: string): Promise<number>;
  close(): Promise<void>;
}

/** Reads a request body, or `null` if it is too big. */
async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The request as API Gateway would hand it to a Lambda, or the answer when it cannot. */
async function toHttpRequest(request: IncomingMessage): Promise<HttpRequest | HttpResponse> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const match = matchRoute(request.method ?? 'GET', url.pathname);
  if (match === null) {
    return jsonResponse(404, { error: 'not_found' });
  }
  const body = await readBody(request);
  if (body === null) {
    return jsonResponse(400, { error: 'validation', reason: 'payload_too_large' });
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : (value ?? '');
  }
  return {
    routeKey: match.routeKey,
    headers,
    body: body === '' ? undefined : body,
    isBase64Encoded: false,
    ...(match.pathParameters !== undefined ? { pathParameters: match.pathParameters } : {}),
    requestId: randomUUID(),
  };
}

const isHttpRequest = (value: HttpRequest | HttpResponse): value is HttpRequest =>
  'routeKey' in value;

export async function createLocalServer(options: LocalBackendOptions): Promise<LocalServer> {
  const backend = await createLocalBackend(options);

  const server: Server = createServer((request, response) => {
    void (async () => {
      const prepared = await toHttpRequest(request);
      const result = isHttpRequest(prepared) ? await backend.handleHttp(prepared) : prepared;
      response.writeHead(result.statusCode, result.headers);
      response.end(result.body);
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { 'Cache-Control': 'no-store' });
      }
      response.end();
    });
  });

  // Messages the Panel sends are tiny (a keepalive), so a small limit is plenty.
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_KEEPALIVE_BYTES * 8 });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== WS_PATH) {
        socket.destroy();
        return;
      }
      // `$connect`: the one-time ticket decides. A wrong, expired or used ticket is a 401.
      const connection = await backend.connect(url.searchParams.get(WS_TICKET_PARAM) ?? undefined);
      if (connection === null) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(request, socket, head, (ws) => {
        const { connectionId } = connection;
        backend.attach(connectionId, (text) => {
          if (ws.readyState !== ws.OPEN) {
            return false;
          }
          ws.send(text);
          return true;
        });
        ws.on('message', (data) => {
          void backend.message(connectionId, data.toString());
        });
        ws.on('close', () => {
          void backend.disconnect(connectionId);
        });
        ws.on('error', () => ws.terminate());
      });
    })().catch(() => socket.destroy());
  });

  return {
    backend,

    listen: (port, host) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve(typeof address === 'object' && address !== null ? address.port : port);
        });
      }),

    close: () =>
      new Promise<void>((resolve) => {
        for (const client of sockets.clients) {
          client.terminate();
        }
        sockets.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
