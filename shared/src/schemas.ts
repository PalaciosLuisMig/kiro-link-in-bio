// Zod schemas for API requests and the typed shapes of API responses.
// Pure TypeScript plus Zod only: no Node, DOM, or AWS imports.
//
// Title and URL are NOT validated with Zod's `.max()`, `.min()`, `.url()` or
// `.trim()`. Those rules live in `link-rules.ts` (code-point counting, trim
// semantics, scheme/host checks) and are reused here through `.refine(...)`
// so the exact same logic runs in the domain and in the request schema.

import { z } from 'zod';

import { MAX_CHANNEL_LENGTH } from './constants.js';
import { validateTitle, validateUrl } from './link-rules.js';

// --- Dependency on task 2.3 (`link-rules.ts`) -----------------------------
//
// `link-rules.ts` is not implemented yet (task 2.3 is in progress). We depend
// on it through its expected signature, documented here:
//
//   validateTitle(raw: string): string | null
//     Returns the trimmed title when valid (1..80 code points after trim, no
//     control or bidi-control characters); returns null when invalid.
//
//   validateUrl(raw: string): string | null
//     Returns the URL exactly as received (no trim) when valid (http/https,
//     non-empty host, no credentials, no spaces/control chars, 1..2048 chars);
//     returns null when invalid.
//
// Both are used as boolean predicates inside `.refine(...)`: a non-null result
// means the value is accepted. If task 2.3 lands a different contract, only the
// two refinements below need to change.

/** True when `validateTitle` accepts the raw title. */
function isValidTitle(raw: string): boolean {
  return validateTitle(raw) !== null;
}

/** True when `validateUrl` accepts the raw URL. */
function isValidUrl(raw: string): boolean {
  return validateUrl(raw) !== null;
}

// --- Primitive field schemas ----------------------------------------------

/** A link identifier: a UUID string. */
export const idSchema = z.uuid();

/**
 * Optional source-channel value: a string of up to 256 UTF-16 code units.
 * The channel is normalized (`normalizeChannel`) only after schema validation,
 * so any in-range string is accepted here and later mapped to `otro` if it is
 * not a predefined channel.
 */
const channelSchema = z.string().max(MAX_CHANNEL_LENGTH).optional();

/** Title field, validated by delegating to `validateTitle` from link-rules. */
const titleSchema = z.string().refine(isValidTitle, { message: 'invalid title' });

/** URL field, validated by delegating to `validateUrl` from link-rules. */
const urlSchema = z.string().refine(isValidUrl, { message: 'invalid url' });

// --- Request schemas -------------------------------------------------------

/**
 * Click request: `{ linkId, channel? }`. Uses `strip` (the default) so any
 * extra field is dropped rather than rejected, matching the public click path.
 */
export const ClickRequest = z
  .object({
    linkId: idSchema,
    channel: channelSchema,
  })
  .strip();

/**
 * Visit request: `{ channel? }`. Uses `strip` so extra fields are ignored,
 * matching the public visit path.
 */
export const VisitRequest = z
  .object({
    channel: channelSchema,
  })
  .strip();

/**
 * Create-link request: `{ title, url }`. Uses `strict` so any extra field is
 * rejected, matching the admin management path.
 */
export const CreateLinkRequest = z
  .object({
    title: titleSchema,
    url: urlSchema,
  })
  .strict();

/**
 * Update-link request: `{ title?, url?, active? }` with at least one field
 * present. Uses `strict` so any extra field is rejected.
 */
export const UpdateLinkRequest = z
  .object({
    title: titleSchema.optional(),
    url: urlSchema.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.title !== undefined || value.url !== undefined || value.active !== undefined,
    { message: 'at least one field is required' },
  );

/**
 * Reorder request: `{ ids: uuid[] }`. Uses `strict` so any extra field is
 * rejected. The exact-permutation check lives in the `reorderLinks` use case.
 */
export const ReorderRequest = z
  .object({
    ids: z.array(idSchema),
  })
  .strict();

/** Path-parameter schema for the single-link admin routes: `{ id: uuid }`. */
export const IdParam = z
  .object({
    id: idSchema,
  })
  .strip();

/** Inferred request types. */
export type ClickRequest = z.infer<typeof ClickRequest>;
export type VisitRequest = z.infer<typeof VisitRequest>;
export type CreateLinkRequest = z.infer<typeof CreateLinkRequest>;
export type UpdateLinkRequest = z.infer<typeof UpdateLinkRequest>;
export type ReorderRequest = z.infer<typeof ReorderRequest>;
export type IdParam = z.infer<typeof IdParam>;

// --- Error body ------------------------------------------------------------

/**
 * Error response body. `code` is one of the shared `ERROR_CODES`; `fields`
 * lists the invalid field or parameter names on a validation error. No request
 * body, headers, token, or ticket is ever included.
 */
export const ErrorBody = z
  .object({
    code: z.string(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export type ErrorBody = z.infer<typeof ErrorBody>;

// --- Response types --------------------------------------------------------
//
// Responses are plain typed shapes (not request schemas): the API builds them
// and the frontend consumes them. They are declared as interfaces so the
// public page can import the types without pulling Zod into its bundle.

/** A link as shown to the public page. */
export interface PublicLink {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

/** A link as shown in the admin panel, including management fields. */
export interface AdminLink {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
  readonly position: number;
  readonly clicks: number;
}

/** Response of `GET /api/links`. */
export interface PublicLinksResponse {
  readonly links: PublicLink[];
}

/** Response of `GET /api/admin/links`. */
export interface AdminLinksResponse {
  readonly links: AdminLink[];
}

/** Response of `POST /api/admin/realtime-tickets`. */
export interface TicketResponse {
  readonly ticket: string;
  readonly expiresAt: number;
  readonly wsUrl: string;
}

/** Response of `POST /api/admin/metrics/reset`. */
export interface ResetMetricsResponse {
  readonly epoch: number;
}

/** Response of `PUT /api/admin/links/order`. */
export interface ReorderResponse {
  readonly links: AdminLink[];
}
