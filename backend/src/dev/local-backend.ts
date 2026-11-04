// The backend for LOCAL development: the REAL handlers wired to in-memory doubles.
//
// Nothing here is deployed. It lets the public page and the Panel run on
// localhost with no AWS account: the same `handlePublicRequest`, `handleAdminRequest`,
// `handleWsEvent` and `handleNotifyPanel` that the Lambdas run, but on the in-memory
// doubles of the domain tests instead of DynamoDB, SSM and API Gateway. The data
// lives in memory and is lost when the server stops.

import { serialize, snapshotMessage, type MetricsSnapshot } from '@link-in-bio/shared';

import { SystemClock, NodeRandomSource, UuidIdGenerator } from '../lib/adapters/node-services.js';
import { ConsoleLogger } from '../lib/adapters/logger.js';
import { createLink } from '../lib/domain/manage-links.js';
import type { Clock, Logger, RealtimeNotifier, SendResult } from '../lib/domain/ports.js';
import {
  InMemoryEventRepository,
  InMemoryLinkRepository,
  InMemoryMetricsRepository,
  InMemoryOwnerTokenProvider,
  InMemoryRealtimeAccessRepository,
} from '../lib/domain/testing/fakes.js';
import { handleAdminRequest, type AdminApiDeps } from '../handlers/http/admin-api-routes.js';
import { handlePublicRequest, type PublicApiDeps } from '../handlers/http/public-api-routes.js';
import { handleNotifyPanel } from '../handlers/streams/notify-panel-routes.js';
import { handleWsEvent, type WsDeps } from '../handlers/websocket/ws-routes.js';
import type { HttpRequest, HttpResponse } from '../lib/http/types.js';

import { changesMetrics, isAdminRoute } from './routing.js';

export interface LocalBackendOptions {
  /** The owner token the Panel signs in with (at least 32 characters). */
  readonly ownerToken: string;
  /** The `ws://` URL the Panel is told to connect to (through the Vite proxy). */
  readonly wsUrl: string;
  /** Starts with three sample links. On by default. */
  readonly seed?: boolean;
  /** A fake clock makes the 1 s pause between sends instant in tests. */
  readonly clock?: Clock;
  readonly logger?: Logger;
}

export interface LocalConnection {
  readonly connectionId: string;
}

export interface LocalBackend {
  handleHttp(request: HttpRequest): Promise<HttpResponse>;
  /** `$connect`: checks the one-time ticket. `null` means the connection is refused (401). */
  connect(ticket: string | undefined): Promise<LocalConnection | null>;
  /** Gives an accepted connection its way to send text. Returns false from `send` once closed. */
  attach(connectionId: string, send: (text: string) => boolean): void;
  /** `$default`: a message from the Panel (only keepalives matter, and they need no answer). */
  message(connectionId: string, body: string): Promise<void>;
  /** `$disconnect`. */
  disconnect(connectionId: string): Promise<void>;
  /** Resolves when no notification is running or waiting. For tests. */
  idle(): Promise<void>;
}

/** Sample links, so the public page is not empty the first time it is opened. */
export const SEED_LINKS = [
  { title: '📜 Código Fuente', url: 'https://github.com/PalaciosLuisMig/demo-ssd-kiro' },
  { title: '🌲 Mi GitHub', url: 'https://github.com/palaciosluismig' },
  { title: '🪪 Mi LinkedIn', url: 'https://www.linkedin.com/in/palaciosluismig/' },
  { title: '🚀 Mi blog', url: 'https://luispalacios.dev/blog/ya-conoces-kiro/' },
  { title: '👻 Web Oficial Kiro', url: 'https://kiro.dev/' },
] as const;

/**
 * Delivers a snapshot to a Panel connected to the local WebSocket server.
 *
 * A connection that was accepted but has not attached its socket yet is `pending`:
 * the send is skipped, not reported as `gone`, so the connection is not removed
 * by a notification that arrives in that short window.
 */
class LocalNotifier implements RealtimeNotifier {
  readonly sockets = new Map<string, (text: string) => boolean>();
  readonly pending = new Set<string>();

  async send(connectionId: string, payload: MetricsSnapshot): Promise<SendResult> {
    const send = this.sockets.get(connectionId);
    if (send !== undefined) {
      return send(serialize(snapshotMessage(payload))) ? 'sent' : 'gone';
    }
    return this.pending.has(connectionId) ? 'sent' : 'gone';
  }
}

export async function createLocalBackend(options: LocalBackendOptions): Promise<LocalBackend> {
  const clock = options.clock ?? new SystemClock();
  const logger = options.logger ?? new ConsoleLogger();
  const ids = new UuidIdGenerator();

  const metrics = new InMemoryMetricsRepository();
  const links = new InMemoryLinkRepository((id) => metrics.clicksOf(id));
  const events = new InMemoryEventRepository();
  const realtime = new InMemoryRealtimeAccessRepository();
  const notifier = new LocalNotifier();

  const publicDeps: PublicApiDeps = { links, metrics, events, clock, ids, logger };
  const adminDeps: AdminApiDeps = {
    links,
    metrics,
    events,
    realtime,
    ownerToken: new InMemoryOwnerTokenProvider(options.ownerToken),
    clock,
    ids,
    random: new NodeRandomSource(),
    logger,
    wsUrl: options.wsUrl,
  };
  const wsDeps: WsDeps = { realtime, clock, logger };

  if (options.seed !== false) {
    for (const sample of SEED_LINKS) {
      await createLink(links, ids, { ...sample, now: clock.now() });
    }
  }

  // --- Notifications ---------------------------------------------------------
  // In AWS a DynamoDB stream wakes `notify-panel`. Here a write to the metrics does
  // it. One run at a time, and `handleNotifyPanel` itself keeps at least 1 s between
  // sends, exactly as in AWS; a write that happens meanwhile triggers one more run.
  let running: Promise<void> | null = null;
  let again = false;

  const pump = async (): Promise<void> => {
    do {
      again = false;
      try {
        await handleNotifyPanel({
          realtime,
          notifier,
          logger,
          metrics: { links, metrics, events, clock },
        });
      } catch {
        logger.error('local_notify_failed', { code: 'local_notify_failed' });
      }
    } while (again);
  };

  const scheduleNotify = (): void => {
    if (running !== null) {
      again = true;
      return;
    }
    running = pump().finally(() => {
      running = null;
    });
  };

  // --- The backend -----------------------------------------------------------
  return {
    async handleHttp(request) {
      const response = isAdminRoute(request.routeKey)
        ? await handleAdminRequest(adminDeps, request)
        : await handlePublicRequest(publicDeps, request);
      if (changesMetrics(request.routeKey) && response.statusCode < 300) {
        scheduleNotify();
      }
      return response;
    },

    async connect(ticket) {
      const connectionId = ids.next();
      const result = await handleWsEvent(wsDeps, {
        routeKey: '$connect',
        connectionId,
        ticket,
      });
      if (result.statusCode !== 200) {
        return null;
      }
      notifier.pending.add(connectionId);
      return { connectionId };
    },

    attach(connectionId, send) {
      notifier.pending.delete(connectionId);
      notifier.sockets.set(connectionId, send);
    },

    async message(connectionId, body) {
      await handleWsEvent(wsDeps, { routeKey: '$default', connectionId, body });
    },

    async disconnect(connectionId) {
      notifier.pending.delete(connectionId);
      notifier.sockets.delete(connectionId);
      await handleWsEvent(wsDeps, { routeKey: '$disconnect', connectionId });
    },

    async idle() {
      while (running !== null) {
        await running;
      }
    },
  };
}
