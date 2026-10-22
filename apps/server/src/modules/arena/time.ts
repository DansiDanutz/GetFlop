/**
 * Calendar helpers in the platform time zone (weeks close Monday 00:00, caps reset at midnight).
 * Day keys are 'YYYY-MM-DD' strings of the local calendar.
 */
const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface LocalParts { y: number; m: number; d: number; h: number; min: number; s: number }

function localParts(date: Date, timeZone: string): LocalParts {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), min: Number(parts.minute), s: Number(parts.second) };
}

/** Local time minus UTC, in ms, at that instant. */
function offsetMs(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const keyOf = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

function parseKey(key: string): [number, number, number] {
  const [y, m, d] = key.split('-').map(Number);
  return [y!, m!, d ?? 1];
}

export function dayKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return keyOf(p.y, p.m, p.d);
}

export function addDays(key: string, days: number): string {
  const [y, m, d] = parseKey(key);
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return keyOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** The instant of local 00:00 on a day key. */
export function midnight(key: string, timeZone: string): Date {
  const [y, m, d] = parseKey(key);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(new Date(guess), timeZone);
  const second = guess - offsetMs(new Date(first), timeZone);
  return new Date(second);
}

export function dayStart(date: Date, timeZone: string): Date {
  return midnight(dayKey(date, timeZone), timeZone);
}

/** Monday of the local week, as a day key. */
export function weekKey(date: Date, timeZone: string): string {
  const key = dayKey(date, timeZone);
  const [y, m, d] = parseKey(key);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(key, -weekday);
}

export const weekStart = (date: Date, timeZone: string): Date => midnight(weekKey(date, timeZone), timeZone);
export const nextWeekStart = (date: Date, timeZone: string): Date => midnight(addDays(weekKey(date, timeZone), 7), timeZone);

export function monthKey(date: Date, timeZone: string): string {
  return dayKey(date, timeZone).slice(0, 7);
}

export const monthStart = (date: Date, timeZone: string): Date => midnight(`${monthKey(date, timeZone)}-01`, timeZone);

export function nextMonthStart(date: Date, timeZone: string): Date {
  const [y, m] = parseKey(monthKey(date, timeZone));
  return midnight(m === 12 ? `${y + 1}-01-01` : keyOf(y, m + 1, 1), timeZone);
}

export interface PeriodKeys { readonly week: string; readonly month: string; readonly all: 'all' }

/** Stats period keys for the instant: 'w:<monday>', 'm:<YYYY-MM>', 'all'. */
export function periodKeys(date: Date, timeZone: string): PeriodKeys {
  return { week: `w:${weekKey(date, timeZone)}`, month: `m:${monthKey(date, timeZone)}`, all: 'all' };
}
