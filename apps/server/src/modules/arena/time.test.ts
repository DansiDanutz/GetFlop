import { describe, expect, it } from 'vitest';
import { addDays, dayKey, dayStart, monthKey, monthStart, nextMonthStart, nextWeekStart, periodKeys, weekKey } from './time.js';

const TZ = 'Europe/Athens';

describe('platform time (Europe/Athens)', () => {
  it('uses the local calendar day, not UTC', () => {
    // 22:30 UTC on Sunday is already Monday 01:30 in Athens (summer, UTC+3).
    const d = new Date('2026-09-27T22:30:00Z');
    expect(dayKey(d, TZ)).toBe('2026-09-28');
    expect(weekKey(d, TZ)).toBe('2026-09-28');
    expect(weekKey(new Date('2026-09-27T20:59:00Z'), TZ)).toBe('2026-09-21');
  });

  it('finds local midnight across daylight saving changes', () => {
    expect(dayStart(new Date('2026-09-24T18:00:00Z'), TZ).toISOString()).toBe('2026-09-23T21:00:00.000Z');
    expect(dayStart(new Date('2026-12-01T12:00:00Z'), TZ).toISOString()).toBe('2026-11-30T22:00:00.000Z');
    // DST ends Sunday 25 Oct 2026: the next Monday starts at UTC+2.
    expect(nextWeekStart(new Date('2026-10-22T10:00:00Z'), TZ).toISOString()).toBe('2026-10-25T22:00:00.000Z');
  });

  it('computes months and period keys', () => {
    const d = new Date('2026-09-30T21:30:00Z'); // 1 Oct 00:30 local
    expect(monthKey(d, TZ)).toBe('2026-10');
    expect(monthStart(d, TZ).toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(nextMonthStart(new Date('2026-12-15T10:00:00Z'), TZ).toISOString()).toBe('2026-12-31T22:00:00.000Z');
    expect(periodKeys(new Date('2026-09-24T18:00:00Z'), TZ)).toEqual({ week: 'w:2026-09-21', month: 'm:2026-09', all: 'all' });
  });

  it('adds days to a day key', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});
