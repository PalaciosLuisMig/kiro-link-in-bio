// Time formats of the Panel, in the browser's time zone (Requirements 9.5, 15.2).

/** Shown when a time cannot be read, so a bad value never breaks the screen. */
const UNKNOWN_TIME = '--:--:--';

function formatter(withSeconds: boolean, timeZone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('es', {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    // `h23` keeps midnight as 00 and never adds "a. m." or "p. m." (HH:MM:SS).
    hourCycle: 'h23',
    ...(timeZone !== undefined ? { timeZone } : {}),
  });
}

/** `HH:MM:SS` of an ISO 8601 time, in the given time zone (the browser's by default). */
export function formatClock(iso: string, timeZone?: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? formatter(true, timeZone).format(time) : UNKNOWN_TIME;
}

/** `HH:MM` of a minute start in Unix seconds, in the given time zone. */
export function formatMinute(startSec: number, timeZone?: string): string {
  return formatter(false, timeZone).format(startSec * 1000);
}
