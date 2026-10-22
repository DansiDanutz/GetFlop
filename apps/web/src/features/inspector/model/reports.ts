/** Reports logic: period chips, hold figures, market bands, CSV. Pure (tested). */

export type PeriodChip = 'today' | '7d' | '30d' | 'all' | 'custom';

export interface PeriodQuery { dateStart?: string; dateEnd?: string; all?: 1 }

const DAY_START_HOUR = 6;
const DAY_MS = 86_400_000;

/** YYYY-MM-DD of the club day (06:00 → 06:00 local) containing `now`. */
export function clubDay(now: Date, tz: string): string {
  const shifted = new Date(now.getTime() - DAY_START_HOUR * 3_600_000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
  return parts;
}

export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Query parameters of a period chip (custom uses the two dates given). */
export function periodQuery(chip: PeriodChip, now: Date, tz: string, custom?: { from: string; to: string }): PeriodQuery {
  const today = clubDay(now, tz);
  switch (chip) {
    case 'today': return { dateStart: today, dateEnd: today };
    case '7d': return { dateStart: shiftDay(today, -6), dateEnd: today };
    case '30d': return { dateStart: shiftDay(today, -29), dateEnd: today };
    case 'all': return { all: 1 };
    case 'custom': return custom && custom.from && custom.to ? { dateStart: custom.from, dateEnd: custom.to } : { dateStart: today, dateEnd: today };
  }
}

/** 0.1234 → "12.3%"; null → "—". */
export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export interface MarketStat {
  slug: string;
  picks: number;
  hits: number;
  expectedHits: number;
  handleCents: number;
  paidCents: number;
  resultCents: number;
  holdPct: number | null;
  theoHoldPct: number;
  lowPct: number;
  highPct: number;
  verdict: 'low_volume' | 'inside' | 'above' | 'below';
}

/** Markets outside their band (or too thin to read) stay listed; the ones inside collapse into one line. */
export function collapseInside(stats: readonly MarketStat[]): { listed: MarketStat[]; insideCount: number } {
  return { listed: stats.filter((s) => s.verdict !== 'inside'), insideCount: stats.filter((s) => s.verdict === 'inside').length };
}

/** Positions (0–100) of the 95% band and the actual hold on a shared scale for the interval bar. */
export function bandPositions(s: MarketStat): { low: number; high: number; theo: number; actual: number | null } {
  const values = [s.lowPct, s.highPct, s.theoHoldPct, ...(s.holdPct === null ? [] : [s.holdPct])];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const at = (v: number) => Math.round(((v - min) / span) * 1000) / 10;
  return { low: at(s.lowPct), high: at(s.highPct), theo: at(s.theoHoldPct), actual: s.holdPct === null ? null : at(s.holdPct) };
}

const FORMULA_START = /^[=+@\t\r]|^-(?!\d)/;

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const safe = FORMULA_START.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV of the current view (client-side export). */
export function toCsv(headers: readonly string[], rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export const centsToCsv = (cents: number): string => (cents / 100).toFixed(2);

/** Triggers a file download in the browser. */
export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Browser IANA timezone. */
export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Athens';
  } catch {
    return 'Europe/Athens';
  }
}

/** Datetime-local input value ("2026-09-24T18:00") → ISO string, or null. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isoToLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
