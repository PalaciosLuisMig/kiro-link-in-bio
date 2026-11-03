// Pure translation of AWS SDK (DynamoDB) errors into domain outcomes.
//
// This module is in the ADAPTERS layer, so it may depend on the AWS SDK
// (`structure.md`). It stays PURE: it inspects an error object and decides what
// it means, performing NO I/O and holding NO client. The real DynamoDB adapters
// (task 9.3) call these helpers so the mapping from an SDK failure to a domain
// error (or a boolean outcome) lives in ONE place and is unit-testable without a
// client or AWS.
//
// Why match on `error.name` rather than `instanceof`:
//   AWS SDK v3 modelled service errors (`ConditionalCheckFailedException`,
//   `TransactionCanceledException`, ...) all carry a stable `name` string equal
//   to the exception's shape name. Matching on `name` is the robust approach:
//   it survives bundling/minification, works across SDK sub-package versions,
//   and does not depend on importing the concrete error classes at runtime.
//   The SDK does export these classes, but only their TYPE is needed here.
//
// The three outcomes this module encodes (design "Error Handling"):
//   - Consuming a ticket: a `ConditionalCheckFailedException` means the ticket
//     was NOT consumed (expired, already used, or never existed). The adapter's
//     `consumeTicket` returns `false` in that case; it does NOT throw. Hence a
//     boolean-shaped helper, `isConditionalCheckFailed`, rather than a thrower.
//   - Editing a link (`buildUpdateLinkUpdate`): a
//     `ConditionalCheckFailedException` means `attribute_exists(pk)` failed, so
//     the link does not exist -> `NotFound` (Requirement 6.12).
//   - Reordering (`buildReorderTransaction`): a `TransactionCanceledException`
//     means at least one conditional `Update` was cancelled (a link vanished),
//     which is a client-visible invalid reorder -> `ValidationError`
//     (Requirement 6.13), never a bare 500.
//
// Any OTHER error is deliberately left untouched: these helpers either return
// `false`/do nothing, or rethrow the original error unchanged, so an unexpected
// failure is never swallowed and bubbles up to the pipeline's generic 500.

import { ERROR_REASONS } from '@link-in-bio/shared';

import { NotFound, ValidationError } from '../domain/errors.js';

/** `name` of the DynamoDB conditional-check failure (single `PutItem`/`UpdateItem`/`DeleteItem`). */
const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';

/** `name` of the DynamoDB transaction cancellation (`TransactWriteItems`). */
const TRANSACTION_CANCELLED = 'TransactionCanceledException';

/**
 * Reads the `name` of an unknown error-like value, or `undefined` when the
 * value is not an object with a string `name`. Centralises the defensive access
 * so each predicate stays a one-liner.
 */
function errorName(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') {
      return name;
    }
  }
  return undefined;
}

/**
 * True when `error` is a DynamoDB `ConditionalCheckFailedException`.
 *
 * On the ticket path this means the atomic consume (`buildConsumeTicketDelete`,
 * `expiresAt > :now`) did not match, i.e. the ticket was NOT consumed. The
 * adapter's `consumeTicket` uses this to RETURN `false` rather than throw
 * (Requirements 5.7, 5.16): a missing/expired/already-used ticket is a normal
 * negative outcome, not an error.
 */
export function isConditionalCheckFailed(error: unknown): boolean {
  return errorName(error) === CONDITIONAL_CHECK_FAILED;
}

/**
 * Translates an error thrown by the conditional link EDIT
 * (`buildUpdateLinkUpdate`, guarded by `attribute_exists(pk)`): a
 * `ConditionalCheckFailedException` becomes a {@link NotFound}, because the
 * condition only fails when the link does not exist (Requirement 6.12). Any
 * other error is rethrown unchanged so it is never swallowed.
 *
 * This NEVER returns normally: it always throws. The `never` return type lets a
 * caller write `throw mapUpdateLinkError(error)` inside a `catch` and keep the
 * type checker happy about the surrounding function's control flow.
 *
 * @param error The error thrown by the `UpdateItem` send.
 * @throws NotFound when the error is a conditional-check failure.
 * @throws unknown the original error, unchanged, otherwise.
 */
export function mapUpdateLinkError(error: unknown): never {
  if (isConditionalCheckFailed(error)) {
    throw new NotFound('link not found');
  }
  throw error;
}

/**
 * Translates an error thrown by the reorder transaction
 * (`buildReorderTransaction`): a `TransactionCanceledException` becomes a
 * {@link ValidationError} naming the `ids` field, because a cancelled
 * transaction means a link in the requested order no longer exists, i.e. the
 * reorder is not a valid permutation anymore (Requirement 6.13) — a client
 * error, not a server 500. Any other error is rethrown unchanged.
 *
 * Always throws; see {@link mapUpdateLinkError} for the `never` rationale.
 *
 * @param error The error thrown by the `TransactWriteItems` send.
 * @throws ValidationError when the error is a cancelled transaction.
 * @throws unknown the original error, unchanged, otherwise.
 */
export function mapReorderError(error: unknown): never {
  if (errorName(error) === TRANSACTION_CANCELLED) {
    throw new ValidationError(
      'reorder could not be applied',
      ['ids'],
      ERROR_REASONS.idsNotPermutation,
    );
  }
  throw error;
}
