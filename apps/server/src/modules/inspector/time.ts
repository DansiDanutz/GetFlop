import { z } from 'zod';
import { AppError } from '../../http/errors.js';

/** Club days and the session cut-off start at 06:00 club local time. */
export const DAY_START_HOUR = 6;
export const DEFAULT_TZ = 'Europe/Athens';
const DAY_MS = 86_400_000;

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Optional `tz` query parameter; invalid zones are rejected. */
export const tzSchema = z.string().max(64).refine(isValidTz).optional();

interface LocalParts { y: number; m: number; d: number; h: number; mi: number }

function partsIn(date: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  });
  const get = (type: string) => Number(fmt.formatToParts(date).find((p) => p.type === type)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute') };
}

/** Offset of `tz` from UTC at an instant, in ms. */
function offsetMs(date: Date, tz: string): number {
  const p = partsIn(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  return asUtc - Math.floor(date.getTime() / 60_000) * 60_000;
}

/** The UTC instant of a wall-clock time in `tz`. */
export function localToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetMs(new Date(guess), tz);
  const second = guess - offsetMs(new Date(first), tz);
  return new Date(second);
}

/** Start of the club day containing `at` (the latest 06:00 local at or before it). */
export function clubDayStart(at: Date, tz: string): Date {
  const p = partsIn(at, tz);
  const today = localToUtc(p.y, p.m, p.d, DAY_START_HOUR, 0, tz);
  if (today.getTime() <= at.getTime()) return today;
  const y = partsIn(new Date(at.getTime() - DAY_MS), tz);
  return localToUtc(y.y, y.m, y.d, DAY_START_HOUR, 0, tz);
}

/** The first 06:00 local strictly after `at`. */
export function nextCutoff(at: Date, tz: string): Date {
  const start = clubDayStart(at, tz);
  const p = partsIn(new Date(start.getTime() + DAY_MS + 3_600_000), tz);
  return localToUtc(p.y, p.m, p.d, DAY_START_HOUR, 0, tz);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDay(text: string): { y: number; m: number; d: number } {
  const match = DATE_RE.exec(text);
  if (!match) throw new AppError('report.range_invalid');
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

export interface Range { readonly from: Date; readonly to: Date }

/** YYYY-MM-DD club days (inclusive) → [first day 06:00, day after last 06:00). */
export function dateRange(dateStart: string, dateEnd: string, tz: string): Range {
  const a = parseDay(dateStart);
  const b = parseDay(dateEnd);
  const from = localToUtc(a.y, a.m, a.d, DAY_START_HOUR, 0, tz);
  const endDay = new Date(Date.UTC(b.y, b.m - 1, b.d) + DAY_MS);
  const to = localToUtc(endDay.getUTCFullYear(), endDay.getUTCMonth() + 1, endDay.getUTCDate(), DAY_START_HOUR, 0, tz);
  if (from.getTime() >= to.getTime()) throw new AppError('report.range_order');
  return { from, to };
}

/**
 * Upper bound of an open-ended window ("since X"). Ledger rows carry the database clock,
 * so "until now" must not cut rows written a moment after the request's clock.
 */
export const OPEN_END = new Date('9999-12-31T23:59:59.999Z');

/** Everything recorded. */
export const allTime = (): Range => ({ from: new Date(0), to: OPEN_END });

/** Last `days` club days ending with today. */
export function lastDays(now: Date, days: number, tz: string): Range {
  const today = clubDayStart(now, tz);
  return { from: new Date(today.getTime() - (days - 1) * DAY_MS), to: OPEN_END };
}

/** A club's timezone (settings.timezone), or the request's, or the default. */
export function clubTz(settings: Record<string, unknown> | null | undefined, requested?: string): string {
  if (requested && isValidTz(requested)) return requested;
  const own = typeof settings?.timezone === 'string' ? settings.timezone : undefined;
  return own && isValidTz(own) ? own : DEFAULT_TZ;
}
