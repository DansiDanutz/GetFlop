import { describe, expect, it } from 'vitest';
import { clubDayStart, dateRange, isValidTz, localToUtc, nextCutoff } from './time.js';

describe('club-local time', () => {
  it('converts a local wall-clock time to UTC across DST', () => {
    // Athens is UTC+3 in summer, UTC+2 in winter.
    expect(localToUtc(2026, 9, 24, 6, 0, 'Europe/Athens').toISOString()).toBe('2026-09-24T03:00:00.000Z');
    expect(localToUtc(2026, 12, 1, 6, 0, 'Europe/Athens').toISOString()).toBe('2026-12-01T04:00:00.000Z');
    expect(localToUtc(2026, 9, 24, 6, 0, 'UTC').toISOString()).toBe('2026-09-24T06:00:00.000Z');
  });

  it('starts the club day at 06:00 local, yesterday before 06:00', () => {
    expect(clubDayStart(new Date('2026-09-24T18:00:00Z'), 'Europe/Athens').toISOString()).toBe('2026-09-24T03:00:00.000Z');
    expect(clubDayStart(new Date('2026-09-24T02:00:00Z'), 'Europe/Athens').toISOString()).toBe('2026-09-23T03:00:00.000Z');
  });

  it('finds the next 06:00 cut-off after a moment', () => {
    expect(nextCutoff(new Date('2026-09-24T18:00:00Z'), 'Europe/Athens').toISOString()).toBe('2026-09-25T03:00:00.000Z');
    expect(nextCutoff(new Date('2026-09-24T01:00:00Z'), 'Europe/Athens').toISOString()).toBe('2026-09-24T03:00:00.000Z');
  });

  it('turns YYYY-MM-DD dates into a half-open club-day range', () => {
    const r = dateRange('2026-09-20', '2026-09-24', 'UTC');
    expect(r.from.toISOString()).toBe('2026-09-20T06:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-09-25T06:00:00.000Z');
  });

  it('validates IANA zones', () => {
    expect(isValidTz('Europe/Athens')).toBe(true);
    expect(isValidTz('Mars/Olympus')).toBe(false);
  });
});
