// Routes of the public API (no token): links, visits and clicks.
//
// Thin by design: each route goes through the common pipeline and calls one
// domain use case. Nothing from the request other than the validated body
// reaches the domain: no IP, User-Agent or Referer (Requirements 11.1, 11.2).

import {
  API_ROUTES,
  ClickRequest,
  ERROR_CODES,
  VisitRequest,
  type PublicLinksResponse,
} from '@link-in-bio/shared';

import { listPublicLinks } from '../../lib/domain/list-public-links.js';
import type {
  Clock,
  EventRepository,
  IdGenerator,
  LinkRepository,
  Logger,
  MetricsRepository,
} from '../../lib/domain/ports.js';
import { registerClick, registerVisit } from '../../lib/domain/register-activity.js';
import { executePipeline } from '../../lib/http/pipeline.js';
import { errorResponse, jsonResponse } from '../../lib/http/responses.js';
import type { HttpRequest, HttpResponse } from '../../lib/http/types.js';

/** The ports the public API needs, injected by the composition root. */
export interface PublicApiDeps {
  readonly links: LinkRepository;
  readonly metrics: MetricsRepository;
  readonly events: EventRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/** Handles one public API request. Never rejects. */
export async function handlePublicRequest(
  deps: PublicApiDeps,
  request: HttpRequest,
): Promise<HttpResponse> {
  const requestId = request.requestId;
  const logContext = (route: string) => ({
    route,
    ...(requestId !== undefined ? { requestId } : {}),
  });

  switch (request.routeKey) {
    case `GET ${API_ROUTES.publicLinks}`:
      return executePipeline(
        request,
        {
          route: API_ROUTES.publicLinks,
          run: async () => {
            const body: PublicLinksResponse = { links: await listPublicLinks(deps.links) };
            return jsonResponse(200, body);
          },
        },
        deps.logger,
      );

    case `POST ${API_ROUTES.visits}`:
      return executePipeline(
        request,
        {
          route: API_ROUTES.visits,
          bodySchema: VisitRequest,
          run: async ({ body }) => {
            await registerVisit(deps, body.channel, logContext(API_ROUTES.visits));
            return jsonResponse(202, {});
          },
        },
        deps.logger,
      );

    case `POST ${API_ROUTES.clicks}`:
      return executePipeline(
        request,
        {
          route: API_ROUTES.clicks,
          bodySchema: ClickRequest,
          run: async ({ body }) => {
            await registerClick(deps, body.linkId, body.channel, logContext(API_ROUTES.clicks));
            return jsonResponse(202, {});
          },
        },
        deps.logger,
      );

    default:
      return errorResponse(ERROR_CODES.notFound);
  }
}
