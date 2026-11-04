// Client of the admin API for the Panel (task 15.6).
//
// The token goes in the `Authorization` header and nowhere else: never in the URL
// and never in the body (Requirement 5.1). Every call has a 5 s limit. A 401
// becomes an {@link UnauthorizedError}, which the Panel treats as "Token no
// válido"; any other failure stays an `ApiError`.

import {
  API_ROUTES,
  metricsSnapshotSchema,
  type AdminLink,
  type AdminLinksResponse,
  type MetricsSnapshot,
  type ReorderResponse,
  type ResetMetricsResponse,
  type TicketResponse,
} from '@link-in-bio/shared';

import { ApiError, requestJson, type FetchLike } from '../lib/api.js';

/** The API refused the token (401), or there is no usable token to send. */
export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export interface LinkDraft {
  readonly title: string;
  readonly url: string;
}

export interface LinkPatch {
  readonly title?: string;
  readonly url?: string;
  readonly active?: boolean;
}

export interface AdminApi {
  getMetrics(): Promise<MetricsSnapshot>;
  listLinks(): Promise<AdminLink[]>;
  createLink(draft: LinkDraft): Promise<AdminLink>;
  updateLink(id: string, patch: LinkPatch): Promise<AdminLink>;
  deleteLink(id: string): Promise<void>;
  reorderLinks(ids: readonly string[]): Promise<AdminLink[]>;
  /** Resolves with the new epoch. */
  resetMetrics(): Promise<number>;
  issueTicket(): Promise<TicketResponse>;
}

export interface AdminApiDeps {
  readonly fetch: FetchLike;
  /** The saved token, read on every call so a logout takes effect at once. */
  readonly getToken: () => string | null;
}

/**
 * `fetch` can only send header values made of Latin-1 characters (code points up to
 * U+00FF). Written as "nothing above Latin-1" so the pattern holds no control
 * character; a character outside the BMP is two surrogates, also above U+00FF.
 * Built from a string because the formatter rewrites escapes inside a regex
 * literal into raw characters, and the upper bound is not an assigned character.
 */
const LATIN1 = new RegExp('^[^\\u0100-\\uffff]*$');

/** Path of a single-link route, with the id URL-encoded. */
function linkPath(id: string): string {
  return API_ROUTES.adminLink.replace('{id}', encodeURIComponent(id));
}

export function createAdminApi(deps: AdminApiDeps): AdminApi {
  const call = async <T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<T> => {
    const token = deps.getToken();
    // No token, or one `fetch` could not even send: it cannot be the right one,
    // so say so without a request (and without a `TypeError` from the header).
    if (token === null || token === '' || !LATIN1.test(token)) {
      throw new UnauthorizedError();
    }
    try {
      return await requestJson<T>(deps.fetch, path, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        ...(body !== undefined ? { body } : {}),
      });
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'http' && error.status === 401) {
        throw new UnauthorizedError();
      }
      throw error;
    }
  };

  return {
    async getMetrics() {
      const raw = await call<unknown>(API_ROUTES.metrics, 'GET');
      const parsed = metricsSnapshotSchema.safeParse(raw);
      if (!parsed.success) {
        // An answer that is not a snapshot is a failed load, never partial values.
        throw new ApiError('network');
      }
      return parsed.data;
    },

    async listLinks() {
      return (await call<AdminLinksResponse>(API_ROUTES.adminLinks, 'GET')).links;
    },

    createLink(draft) {
      return call<AdminLink>(API_ROUTES.adminLinks, 'POST', draft);
    },

    updateLink(id, patch) {
      return call<AdminLink>(linkPath(id), 'PATCH', patch);
    },

    async deleteLink(id) {
      await call<void>(linkPath(id), 'DELETE');
    },

    async reorderLinks(ids) {
      return (await call<ReorderResponse>(API_ROUTES.adminLinksOrder, 'PUT', { ids: [...ids] }))
        .links;
    },

    async resetMetrics() {
      return (await call<ResetMetricsResponse>(API_ROUTES.metricsReset, 'POST')).epoch;
    },

    issueTicket() {
      return call<TicketResponse>(API_ROUTES.realtimeTickets, 'POST');
    },
  };
}
