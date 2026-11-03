// Transport-neutral request/response shapes of the HTTP pipeline.
//
// The pipeline works on these plain types, not on API Gateway events, so it is
// testable without Lambda and the only place that knows the event format is
// `lambda.ts`.

/** A request as the pipeline sees it. Header names are lowercase. */
export interface HttpRequest {
  /** API Gateway route key, e.g. `POST /api/clicks`. Never carries a query. */
  readonly routeKey: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Raw body exactly as received (base64 text when `isBase64Encoded`). */
  readonly body?: string | undefined;
  readonly isBase64Encoded?: boolean | undefined;
  readonly pathParameters?: Readonly<Record<string, string | undefined>> | undefined;
  /** Lambda invocation / request id (a technical identifier, loggable). */
  readonly requestId?: string | undefined;
}

/** A response the pipeline hands back to the Lambda adapter. */
export interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** The parts of a schema issue the pipeline reads: where and what kind. */
export interface SchemaIssue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
}

/**
 * Minimal structural view of a Zod schema, so this layer does not depend on
 * Zod directly. A `ZodType<T>` satisfies it. Failure details expose only the
 * issue paths: messages and received values are never read.
 */
export interface Schema<T> {
  safeParse(input: unknown):
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: { readonly issues: readonly SchemaIssue[] };
      };
}
