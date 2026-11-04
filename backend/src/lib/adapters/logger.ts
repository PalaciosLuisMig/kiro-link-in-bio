// Node-backed adapter for the Logger port.
//
// This module is in the ADAPTERS layer and is the SINGLE place in the backend
// allowed to touch `console`: the ESLint `no-console` rule is on everywhere in
// `backend/` and exempts only files matching `adapters/**/logger*.ts`. Every
// other adapter, handler and domain module logs exclusively through this port.
//
// Privacy (Requirements 5.18, 11.2): a log entry may contain ONLY the message
// and the allowed context fields (`code`, `route`, `requestId`). The port's
// type already makes a body, headers, the owner token, or a ticket a COMPILE
// error. This adapter adds a RUNTIME guarantee too: it copies out only the three
// allowed fields by name before serializing, so even if an untyped caller (or a
// value widened to `any`) slipped an extra property in, it would never reach the
// output. One JSON line per entry goes to `console.log` (info) or `console.error`
// (error), which CloudWatch captures.

import type { Logger, LogContext, OnlyLogContext } from '../domain/ports.js';

/** The shape of one serialized log line. */
interface LogLine {
  readonly level: 'info' | 'error';
  readonly message: string;
  readonly code?: string;
  readonly route?: string;
  readonly requestId?: string;
}

/**
 * Copies ONLY the allow-listed fields off an arbitrary context, dropping
 * everything else. This is the runtime privacy guard that backs the port's
 * compile-time guarantee: a forbidden field (token, body, headers, ticket)
 * present on the value at runtime is never serialized.
 */
function pickAllowed(
  context: LogContext | undefined,
): Pick<LogLine, 'code' | 'route' | 'requestId'> {
  if (context === undefined) {
    return {};
  }
  const line: { code?: string; route?: string; requestId?: string } = {};
  if (context.code !== undefined) {
    line.code = context.code;
  }
  if (context.route !== undefined) {
    line.route = context.route;
  }
  if (context.requestId !== undefined) {
    line.requestId = context.requestId;
  }
  return line;
}

/**
 * {@link Logger} that writes one JSON line per entry to `console`.
 *
 * `info` goes to `console.log` and `error` to `console.error`. Both serialize
 * only the message and the three allowed context fields; no other data can
 * reach the output (Requirements 5.18, 11.2).
 */
export class ConsoleLogger implements Logger {
  info<T extends LogContext>(message: string, context?: OnlyLogContext<T>): void {
    this.write('info', message, context);
  }

  error<T extends LogContext>(message: string, context?: OnlyLogContext<T>): void {
    this.write('error', message, context);
  }

  private write(level: 'info' | 'error', message: string, context?: LogContext): void {
    const line: LogLine = { level, message, ...pickAllowed(context) };
    const text = JSON.stringify(line);
    if (level === 'error') {
      console.error(text);
    } else {
      console.log(text);
    }
  }
}
