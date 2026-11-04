// Routes of the admin API (owner token): tickets, metrics, reset and link
// management. Every route carries the owner-token provider, so the pipeline
// authorizes before it looks at the body (Requirements 5.3, 5.6).

import {
  API_ROUTES,
  CreateLinkRequest,
  ERROR_CODES,
  IdParam,
  ReorderRequest,
  UpdateLinkRequest,
  type AdminLinksResponse,
  type ReorderResponse,
  type ResetMetricsResponse,
  type TicketResponse,
} from '@link-in-bio/shared';

import { listAdminLinks, toAdminLink } from '../../lib/domain/list-admin-links.js';
import { getMetrics, resetMetrics } from '../../lib/domain/get-metrics.js';
import { createLink, removeLink, reorderLinks, updateLink } from '../../lib/domain/manage-links.js';
import type {
  Clock,
  EventRepository,
  IdGenerator,
  LinkRepository,
  Logger,
  MetricsRepository,
  OwnerTokenProvider,
  RandomSource,
  RealtimeAccessRepository,
} from '../../lib/domain/ports.js';
import { issueTicket } from '../../lib/domain/realtime-access.js';
import { executePipeline } from '../../lib/http/pipeline.js';
import { emptyResponse, errorResponse, jsonResponse } from '../../lib/http/responses.js';
import type { HttpRequest, HttpResponse } from '../../lib/http/types.js';

/** The ports and settings the admin API needs, injected by the composition root. */
export interface AdminApiDeps {
  readonly links: LinkRepository;
  readonly metrics: MetricsRepository;
  readonly events: EventRepository;
  readonly realtime: RealtimeAccessRepository;
  readonly ownerToken: OwnerTokenProvider;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: RandomSource;
  readonly logger: Logger;
  /** Public `wss://` URL of the Panel's WebSocket, returned with each ticket. */
  readonly wsUrl: string;
}

/** Handles one admin API request. Never rejects. */
export async function handleAdminRequest(
  deps: AdminApiDeps,
  request: HttpRequest,
): Promise<HttpResponse> {
  const requestId = request.requestId;
  const logContext = (route: string) => ({
    route,
    ...(requestId !== undefined ? { requestId } : {}),
  });
  const { ownerToken, logger } = deps;

  switch (request.routeKey) {
    case `POST ${API_ROUTES.realtimeTickets}`:
      return executePipeline(
        request,
        {
          route: API_ROUTES.realtimeTickets,
          ownerToken,
          run: async () => {
            const { ticket, expiresAt } = await issueTicket(deps);
            const body: TicketResponse = { ticket, expiresAt, wsUrl: deps.wsUrl };
            return jsonResponse(200, body);
          },
        },
        logger,
      );

    case `GET ${API_ROUTES.metrics}`:
      return executePipeline(
        request,
        {
          route: API_ROUTES.metrics,
          ownerToken,
          run: async () => jsonResponse(200, await getMetrics(deps)),
        },
        logger,
      );

    case `POST ${API_ROUTES.metricsReset}`:
      return executePipeline(
        request,
        {
          route: API_ROUTES.metricsReset,
          ownerToken,
          run: async () => {
            const body: ResetMetricsResponse = {
              epoch: await resetMetrics(deps.metrics, deps.clock),
            };
            return jsonResponse(200, body);
          },
        },
        logger,
      );

    case `GET ${API_ROUTES.adminLinks}`:
      return executePipeline(
        request,
        {
          route: API_ROUTES.adminLinks,
          ownerToken,
          run: async () => {
            const body: AdminLinksResponse = { links: await listAdminLinks(deps.links) };
            return jsonResponse(200, body);
          },
        },
        logger,
      );

    case `POST ${API_ROUTES.adminLinks}`:
      return executePipeline(
        request,
        {
          route: API_ROUTES.adminLinks,
          ownerToken,
          bodySchema: CreateLinkRequest,
          run: async ({ body }) => {
            const link = await createLink(deps.links, deps.ids, {
              title: body.title,
              url: body.url,
              now: deps.clock.now(),
            });
            return jsonResponse(201, toAdminLink(link));
          },
        },
        logger,
      );

    case `PATCH ${API_ROUTES.adminLink}`:
      return executePipeline(
        request,
        {
          route: API_ROUTES.adminLink,
          ownerToken,
          bodySchema: UpdateLinkRequest,
          paramsSchema: IdParam,
          run: async ({ body, params }) => {
            const link = await updateLink(deps.links, params.id, body);
            return jsonResponse(200, toAdminLink(link));
          },
        },
        logger,
      );

    case `DELETE ${API_ROUTES.adminLink}`:
      return executePipeline(
        request,
        {
          route: API_ROUTES.adminLink,
          ownerToken,
          paramsSchema: IdParam,
          run: async ({ params }) => {
            await removeLink(
              deps.links,
              deps.metrics,
              logger,
              params.id,
              logContext(API_ROUTES.adminLink),
            );
            return emptyResponse(204);
          },
        },
        logger,
      );

    case `PUT ${API_ROUTES.adminLinksOrder}`:
      return executePipeline(
        request,
        {
          route: API_ROUTES.adminLinksOrder,
          ownerToken,
          bodySchema: ReorderRequest,
          run: async ({ body }) => {
            await reorderLinks(deps.links, body.ids);
            const response: ReorderResponse = { links: await listAdminLinks(deps.links) };
            return jsonResponse(200, response);
          },
        },
        logger,
      );

    default:
      return errorResponse(ERROR_CODES.notFound);
  }
}
