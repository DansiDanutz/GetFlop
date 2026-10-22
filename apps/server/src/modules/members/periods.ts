import { localMidnight, safeTimeZone } from './range.js';

export type BoardPeriod = 'week' | 'month';

export interface Window { readonly start: Date; readonly end: Date }

const DAY_MS = 86_400_000;

function localParts(now: Date, tz: string): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), weekday: Math.max(0, weekday) };
}

const iso = (y: number, m: number, d: number): string => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

/** Current board window in the club's (or viewer's) time zone: Monday–Monday weeks, calendar months. */
export function periodWindow(period: BoardPeriod, now: Date, tzInput?: unknown): Window {
  const tz = safeTimeZone(tzInput);
  const { y, m, d, weekday } = localParts(now, tz);
  if (period === 'month') {
    return { start: localMidnight(iso(y, m, 1), tz), end: localMidnight(iso(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1), tz) };
  }
  const monday = new Date(Date.UTC(y, m - 1, d) - weekday * DAY_MS);
  const next = new Date(monday.getTime() + 7 * DAY_MS);
  return { start: localMidnight(monday.toISOString().slice(0, 10), tz), end: localMidnight(next.toISOString().slice(0, 10), tz) };
}
