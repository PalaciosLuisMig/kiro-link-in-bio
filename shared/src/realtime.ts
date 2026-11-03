// Real-time message contracts shared between the WebSocket server and the Panel.
// Pure TypeScript plus Zod only: no Node, DOM, or AWS imports. In particular the
// 128-byte keepalive measurement does NOT live here, because shared/ must not use
// `TextEncoder` nor any Node/DOM API; it is done in the `ws` handler with
// `Buffer.byteLength`.

import { z } from 'zod';

/**
 * A single entry of the activity feed.
 *
 * `title` is present only for clicks. `channel` is the normalized source
 * channel and `at` is an ISO 8601 UTC timestamp.
 */
export const activityEventSchema = z.object({
  id: z.string(), // random technical identifier
  type: z.enum(['click', 'visit']),
  title: z.string().optional(), // clicks only
  channel: z.string(),
  at: z.string(), // ISO 8601 UTC
});

/** A single entry of the activity feed. */
export type ActivityEvent = z.infer<typeof activityEventSchema>;

/** Per-channel click and visit counters. */
const channelCountsSchema = z.object({
  clicks: z.number(),
  visits: z.number(),
});

/**
 * An absolute snapshot of the metrics.
 *
 * It is returned by `GET /api/admin/metrics` and pushed over the WebSocket.
 * Every counter is an absolute value, so a repeated or out-of-order snapshot
 * never corrupts the Panel state (which always keeps the larger value).
 *
 * Minute keys are ISO 8601 strings here; the Unix-seconds representation used
 * in DynamoDB and in the Panel state is converted at the boundaries.
 */
export const metricsSnapshotSchema = z.object({
  epoch: z.number(), // 0 until the first reset; afterwards the reset time in ms
  serverTime: z.string(), // ISO 8601 UTC, used to correct the Panel clock
  totals: z.object({
    clicks: z.number(),
    visits: z.number(),
  }),
  links: z.record(z.string(), z.number()), // linkId -> clicks
  minutes: z.record(z.string(), z.number()), // minute start (ISO) -> clicks; last 60 only
  channels: z.record(z.string(), channelCountsSchema),
  events: z.array(activityEventSchema), // up to 20, newest first
});

/** An absolute snapshot of the metrics. */
export type MetricsSnapshot = z.infer<typeof metricsSnapshotSchema>;

/**
 * The only message the server sends to the Panel: a `snapshot` carrying an
 * absolute `MetricsSnapshot`.
 */
export const realtimeMessageSchema = z.object({
  type: z.literal('snapshot'),
  epoch: metricsSnapshotSchema.shape.epoch,
  serverTime: metricsSnapshotSchema.shape.serverTime,
  totals: metricsSnapshotSchema.shape.totals,
  links: metricsSnapshotSchema.shape.links,
  minutes: metricsSnapshotSchema.shape.minutes,
  channels: metricsSnapshotSchema.shape.channels,
  events: metricsSnapshotSchema.shape.events,
});

/** The only message the server sends to the Panel. */
export type RealtimeMessage = z.infer<typeof realtimeMessageSchema>;

/** Builds a `RealtimeMessage` from a metrics snapshot. */
export function snapshotMessage(snapshot: MetricsSnapshot): RealtimeMessage {
  return { type: 'snapshot', ...snapshot };
}

/**
 * The single message the server accepts from the Panel. The Panel sends it
 * every 5 minutes to keep the idle WebSocket connection open.
 */
export const KEEPALIVE = { type: 'keepalive' } as const;

/** The keepalive message type: `{ "type": "keepalive" }`. */
export type KeepaliveMessage = typeof KEEPALIVE;

const keepaliveMessageSchema = z.object({
  type: z.literal('keepalive'),
});

/**
 * A success/error result: either a parsed value or a descriptive error.
 *
 * `parse` returns this instead of throwing so callers can branch on `ok`
 * without a try/catch, and the error message explains why the text was rejected.
 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Serializes a valid `RealtimeMessage` to a JSON text. */
export function serialize(message: RealtimeMessage): string {
  return JSON.stringify(message);
}

/**
 * Parses a raw text into a `RealtimeMessage`.
 *
 * Returns a descriptive error (never throws) when the text is not syntactically
 * valid JSON, or when it is valid JSON that does not match the schema.
 */
export function parse(raw: string): ParseResult<RealtimeMessage> {
  const json = tryParseJson(raw);
  if (!json.ok) {
    return json;
  }

  const result = realtimeMessageSchema.safeParse(json.value);
  if (!result.success) {
    return { ok: false, error: formatZodError(result.error) };
  }

  return { ok: true, value: result.data };
}

/**
 * Parses a raw text into a `KeepaliveMessage`.
 *
 * Returns a descriptive error (never throws) when the text is not syntactically
 * valid JSON, or when it is valid JSON that is not a keepalive message.
 */
export function parseKeepalive(raw: string): ParseResult<KeepaliveMessage> {
  const json = tryParseJson(raw);
  if (!json.ok) {
    return json;
  }

  const result = keepaliveMessageSchema.safeParse(json.value);
  if (!result.success) {
    return { ok: false, error: formatZodError(result.error) };
  }

  return { ok: true, value: KEEPALIVE };
}

/** Parses JSON, turning a syntax error into a descriptive failed result. */
function tryParseJson(raw: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid JSON: ${reason}` };
  }
}

/** Renders a Zod error into a single descriptive line naming the offending paths. */
function formatZodError(error: z.ZodError): string {
  const details = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  return `Does not match the schema: ${details}`;
}
