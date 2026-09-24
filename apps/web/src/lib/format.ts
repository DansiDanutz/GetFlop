import { getLanguage } from '../i18n/i18n';

const locale = () => (getLanguage() === 'el' ? 'el-GR' : 'en-GB');

/** 1234 cents → "12.34"; whole Points drop the decimals ("12"). */
export function points(cents: number | null | undefined): string {
  const value = (cents ?? 0) / 100;
  const whole = Number.isInteger(value);
  return value.toLocaleString(locale(), { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

export const UNIT_LABEL: Record<string, string> = { points: 'PTS', chips: 'TC', stars: '★' };

export function amount(cents: number | null | undefined, unit = 'points'): string {
  return `${points(cents)} ${UNIT_LABEL[unit] ?? 'PTS'}`;
}

export function signed(cents: number, unit = 'points'): string {
  return `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${amount(Math.abs(cents), unit)}`;
}

/** "12.5" / "12,5" typed by a person → cents, or null when invalid (max 2 decimals). */
export function parsePoints(text: string): number | null {
  const clean = text.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

export function multiplier(m: number): string {
  return `×${m.toLocaleString(locale(), { maximumFractionDigits: 2 })}`;
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function date(value: string | Date | null | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ago(value: string | Date | null | undefined, now = Date.now()): string {
  if (!value) return '';
  const s = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}
