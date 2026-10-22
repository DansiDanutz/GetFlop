/** Pure helpers for the admin screens (no React, no I/O). */

/** Club days start at 06:00 local time. */
export const DAY_START_HOUR = 6;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type PeriodPreset = 'today' | '7d' | '30d' | 'all';
export const PERIOD_PRESETS: readonly PeriodPreset[] = ['today', '7d', '30d', 'all'];
const PRESET_DAYS: Record<Exclude<PeriodPreset, 'all'>, number> = { today: 1, '7d': 7, '30d': 30 };

export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Athens';
  } catch {
    return 'Europe/Athens';
  }
}

/** YYYY-MM-DD of the club day containing `at` in `tz`. */
export function clubDay(at: Date, tz: string): string {
  const shifted = new Date(at.getTime() - DAY_START_HOUR * HOUR_MS);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
}

export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

export interface PeriodParams { dateStart?: string; dateEnd?: string; tz: string }

export function periodRange(preset: PeriodPreset, now: Date, tz: string): PeriodParams {
  if (preset === 'all') return { tz };
  const today = clubDay(now, tz);
  return { dateStart: shiftDay(today, -(PRESET_DAYS[preset] - 1)), dateEnd: today, tz };
}

// ───────────── Market pricing ─────────────

export const fairOdds = (probability: number): number => (probability > 0 ? 1 / probability - 1 : 0);
/** House edge `1 − (odds + 1) × chance`. Negative: the club loses on every Point played. */
export const edgeOf = (odds: number, probability: number): number => 1 - (odds + 1) * probability;
const round2 = (n: number) => Math.round(n * 100) / 100;
export const multiplierOf = (odds: number): number => round2(odds + 1);
export const oddsOf = (multiplier: number): number => round2(multiplier - 1);

/** A typed X:1 price: above 0, at most 2 decimals. Null when invalid. */
export function parseOdds(text: string): number | null {
  const clean = text.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const value = Number(clean);
  return value > 0 ? value : null;
}

export function pct(share: number, digits = 1): string {
  return `${round(share * 100, digits)}%`;
}

function round(n: number, digits: number): string {
  const f = 10 ** digits;
  return String(Math.round(n * f) / f);
}

// ───────────── Labels ─────────────

export function handStatusKey(status: string): string {
  switch (status) {
    case 'settled': return 'status_settled';
    case 'cancelled': return 'status_cancelled';
    case 'betting_open': return 'picks_open';
    case 'betting_closed': return 'picks_closed';
    default: return 'status_waiting';
  }
}

export const auditActionKey = (action: string): string => `audit_action_${action.replace(/[.-]/g, '_')}`;
export const verdictKey = (verdict: string): string => `admin_verdict_${verdict}`;

// ───────────── CSV ─────────────

type Cell = string | number | boolean | null | undefined;
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Starts a browser download of a CSV file. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

// ───────────── Tolerant readers (other modules' responses) ─────────────

/** A list whether the endpoint returns it bare or wrapped as `{ [key]: [...] }`. */
export function asList<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>)[key])) {
    return (data as Record<string, T[]>)[key]!;
  }
  return [];
}
