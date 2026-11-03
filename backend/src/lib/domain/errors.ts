// Domain errors for Link in Bio.
//
// The use cases (tasks 5, 6, 7) throw these; the HTTP pipeline (task 10) maps
// each one to an HTTP status and an error code from `shared/`'s `ERROR_CODES`.
// Defining them here, in the domain, keeps the mapping out of the domain: a
// use case says *what* went wrong, the pipeline decides *how* to report it.
//
// This module is pure domain logic: no AWS, no Node, no DOM imports. It imports
// only the shared `ERROR_CODES`/`ErrorCode` types, which the ESLint domain
// boundary allows.
//
// Error precedence (design "Error Handling"): when more than one error applies,
// a misconfigured server wins. A server configured with a short owner token
// makes every admin request fail with 500 `server_error`, ahead of a 401
// `unauthorized` for a wrong token (Requirement 5.5). `ServerMisconfigured`
// therefore carries the highest precedence; the pipeline relies on it being a
// distinct class. The precedence LOGIC lives in the use cases and the pipeline;
// this module only provides the distinct types they branch on.

import { ERROR_CODES, type ErrorCode } from '@link-in-bio/shared';

/**
 * Base class for every domain error.
 *
 * `code` is the stable `ERROR_CODES` string the API returns in the body, so the
 * pipeline maps an error to a response without a chain of `instanceof` checks.
 * The `message` is for logs only and never leaks a request body, headers, the
 * token, or the ticket (Requirements 5.18, 11.2): callers pass a short, static
 * description, not user input.
 */
export abstract class DomainError extends Error {
  /** The stable error code returned in the API response body. */
  abstract readonly code: ErrorCode;

  protected constructor(message: string) {
    super(message);
    // Keep the concrete subclass name on the instance for readable logs and so
    // `error.name` is accurate after transpilation to ES2023.
    this.name = new.target.name;
  }
}

/**
 * A referenced resource does not exist (HTTP 404).
 *
 * Thrown when a click targets a missing, removed, or inactive link, or when an
 * admin operation references a link id that does not exist (Requirements 2.6,
 * 6.12). Carries no identifier in the message to avoid leaking data.
 */
export class NotFound extends DomainError {
  override readonly code = ERROR_CODES.notFound;

  constructor(message = 'resource not found') {
    super(message);
  }
}

/**
 * A bounded collection is full (HTTP 409).
 *
 * Thrown by `createLink` when the owner already has the maximum of 10 links
 * (Requirement 6.9). Nothing is created.
 */
export class LimitReached extends DomainError {
  override readonly code = ERROR_CODES.limitReached;

  constructor(message = 'limit reached') {
    super(message);
  }
}

/**
 * The input is semantically invalid (HTTP 400).
 *
 * Thrown for domain-level validation that the request schema cannot express,
 * such as a reorder whose ids are not an exact permutation of the existing
 * links (Requirement 6.13). `fields` optionally names the offending field(s)
 * so the pipeline can include them in the `fields` array of the error body;
 * it never contains a value, only a field name.
 */
export class ValidationError extends DomainError {
  override readonly code = ERROR_CODES.validation;

  /** Names of the offending fields, if any. Never contains values. */
  readonly fields?: readonly string[];

  constructor(message = 'validation failed', fields?: readonly string[]) {
    super(message);
    if (fields !== undefined) {
      this.fields = fields;
    }
  }
}

/**
 * The owner token is missing, empty, or wrong (HTTP 401).
 *
 * Thrown by `authorizeOwner` for any token other than the configured one
 * (Requirement 5.3). It carries no token value, by design.
 */
export class Unauthorized extends DomainError {
  override readonly code = ERROR_CODES.unauthorized;

  constructor(message = 'unauthorized') {
    super(message);
  }
}

/**
 * The server is misconfigured (HTTP 500).
 *
 * Thrown by `authorizeOwner` when the configured owner token is shorter than 32
 * characters (Requirement 5.5). This error has the highest precedence: with a
 * short server token every admin request fails with 500, ahead of a 401, so an
 * attacker cannot distinguish "wrong token" from "server misconfigured". The
 * response exposes no detail.
 */
export class ServerMisconfigured extends DomainError {
  override readonly code = ERROR_CODES.serverError;

  constructor(message = 'server misconfigured') {
    super(message);
  }
}

/**
 * Type guard for any domain error, so the pipeline can tell a known domain
 * failure (mapped to a specific status) from an unexpected one (mapped to a
 * bare 500 with no details).
 */
export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
