import { AppError } from '../../http/errors.js';

export interface DateRange {
  readonly start: Date;
  readonly end: Date;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function safeTimeZone(tz: unknown): string {
  if (typeof tz !== 'string' || !tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Offset (ms) of `tz` from UTC at the given instant. */
function offsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant of local midnight of a YYYY-MM-DD day in `tz`. */
export function localMidnight(day: string, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(guess, tz);
  return new Date(guess - offsetMs(first, tz));
}

function parseBound(value: string, tz: string, endOfDay: boolean): Date {
  if (DAY_RE.test(value)) {
    const start = localMidnight(value, tz);
    return endOfDay ? localMidnight(new Date(start.getTime() + DAY_MS + 12 * 3_600_000).toISOString().slice(0, 10), tz) : start;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError('report.range_invalid');
  return date;
}

/**
 * Optional report range: both or neither of dateStart/dateEnd. Plain days are local days in `tz`
 * and the end day is inclusive.
 */
export function parseRange(query: { dateStart?: unknown; dateEnd?: unknown; tz?: unknown }): DateRange | null {
  const { dateStart, dateEnd } = query;
  if (dateStart === undefined && dateEnd === undefined) return null;
  if (typeof dateStart !== 'string' || typeof dateEnd !== 'string' || !dateStart || !dateEnd) {
    throw new AppError('report.range_invalid');
  }
  const tz = safeTimeZone(query.tz);
  const start = parseBound(dateStart, tz, false);
  const end = parseBound(dateEnd, tz, true);
  if (start.getTime() >= end.getTime()) throw new AppError('report.range_order');
  return { start, end };
}
