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
 * Error codes returned in the `error` field of a failed API response. They
 * describe the failure independently of the HTTP status so the frontend and the
 * tests can branch on a stable string instead of a status number.
 */
export const ERROR_CODES = {
  /** Request body or parameters failed schema validation. */
  validation: 'validation',
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

/**
 * Optional `reason` of an error response: a finer cause under the same error
 * code, so the code table stays small (design "Error Handling").
 */
export const ERROR_REASONS = {
  /** Request body exceeded the maximum decoded size (error `validation`). */
  payloadTooLarge: 'payload_too_large',
  /**
   * A reorder whose ids are not an exact permutation of the existing links:
   * some are missing, repeated or unknown (error `validation`, Requirement 6.13).
   */
  idsNotPermutation: 'ids_not_permutation',
} as const;

/** A value of the `ERROR_REASONS` map. */
export type ErrorReason = (typeof ERROR_REASONS)[keyof typeof ERROR_REASONS];

/** Maximum decoded request body size in bytes (10 KB). */
export const MAX_BODY_BYTES = 10240;

/** Maximum length (UTF-16 code units) of a source-channel value in a request. */
export const MAX_CHANNEL_LENGTH = 256;

/** Maximum number of links the owner can have (active plus inactive). */
export const MAX_LINKS = 10;

/**
 * Names of the environment variables the Lambdas read. Defined once so the
 * composition roots (backend) and the CDK constructs (infra) never drift apart.
 */
export const ENV_VARS = {
  /** Name of the single DynamoDB table (`LinkInBioTable`). */
  tableName: 'TABLE_NAME',
  /** Name of the SSM SecureString parameter holding the owner token. */
  ownerTokenParameter: 'OWNER_TOKEN_PARAMETER',
  /** Public `wss://` URL the Panel connects to; returned with each ticket. */
  wsUrl: 'WS_URL',
  /** `https://` management endpoint of the WebSocket stage (PostToConnection). */
  wsManagementEndpoint: 'WS_MANAGEMENT_ENDPOINT',
} as const;

/**
 * WebSocket route selection expression. A message is routed by its `action`
 * property; the Panel's `{ "type": "keepalive" }` has none, so it lands on the
 * `$default` route, which is the only message route the `ws` Lambda serves.
 */
export const ROUTE_SELECTION_EXPRESSION = '$request.body.action';

/** Name of the query-string parameter that carries the connection ticket. */
export const WS_TICKET_PARAM = 'ticket';

/** Largest WebSocket message, in bytes, the server accepts as a keepalive. */
export const MAX_KEEPALIVE_BYTES = 128;
