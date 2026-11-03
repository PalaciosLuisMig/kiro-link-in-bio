// Shared API constants: route paths and error codes.
// Defined once here so the three workspaces (frontend, backend, infra) never
// repeat the same string literals.
// Pure TypeScript only: no Node, DOM, or AWS imports.

/**
 * API route paths, all hanging off `/api`. CloudFront forwards these to the
 * HTTP API without caching. `{id}` is the API Gateway path-parameter template
 * for the single-link admin routes.
 */
export const API_ROUTES = {
  // Public API (no token).
  publicLinks: '/api/links',
  visits: '/api/visits',
  clicks: '/api/clicks',
  // Admin API (owner token).
  realtimeTickets: '/api/admin/realtime-tickets',
  metrics: '/api/admin/metrics',
  metricsReset: '/api/admin/metrics/reset',
  adminLinks: '/api/admin/links',
  adminLink: '/api/admin/links/{id}',
  adminLinksOrder: '/api/admin/links/order',
} as const;

/** A value of the `API_ROUTES` map. */
export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];

/**
 * Error codes returned in the body of a failed API response (`{ code }`).
 * They describe the reason independently of the HTTP status so the frontend
 * and the tests can branch on a stable string instead of a status number.
 */
export const ERROR_CODES = {
  /** Request body or parameters failed schema validation. */
  validation: 'validation',
  /** Request body exceeded the maximum decoded size. */
  payloadTooLarge: 'payload_too_large',
  /** Missing, empty, or non-matching owner token. */
  unauthorized: 'unauthorized',
  /** Target link (or other resource) does not exist. */
  notFound: 'not_found',
  /** The 10-link limit has been reached. */
  limitReached: 'limit_reached',
  /** Unexpected server-side failure with no details exposed. */
  serverError: 'server_error',
} as const;

/** A value of the `ERROR_CODES` map. */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Maximum decoded request body size in bytes (10 KB). */
export const MAX_BODY_BYTES = 10240;

/** Maximum length (UTF-16 code units) of a source-channel value in a request. */
export const MAX_CHANNEL_LENGTH = 256;

/** Maximum number of links the owner can have (active plus inactive). */
export const MAX_LINKS = 10;
