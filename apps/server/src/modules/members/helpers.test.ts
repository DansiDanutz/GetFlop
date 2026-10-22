import { describe, expect, it } from 'vitest';
import { longestWeekRun } from './medals.js';
import { periodWindow } from './periods.js';
import { assertLogo } from './photo.js';
import { localMidnight, parseRange, safeTimeZone } from './range.js';
import { pointsToCents } from './settings.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('date ranges', () => {
  it('finds local midnight across time zones and DST', () => {
    expect(localMidnight('2026-09-24', 'Europe/Athens').toISOString()).toBe('2026-09-23T21:00:00.000Z');
    expect(localMidnight('2026-01-15', 'Europe/Athens').toISOString()).toBe('2026-01-14T22:00:00.000Z');
    expect(localMidnight('2026-09-24', 'UTC').toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(localMidnight('2026-09-24', 'America/New_York').toISOString()).toBe('2026-09-24T04:00:00.000Z');
  });

  it('treats the end day as inclusive and validates both bounds', () => {
    expect(parseRange({})).toBeNull();
    const r = parseRange({ dateStart: '2026-09-24', dateEnd: '2026-09-24', tz: 'Europe/Athens' })!;
    expect([r.start.toISOString(), r.end.toISOString()]).toEqual(['2026-09-23T21:00:00.000Z', '2026-09-24T21:00:00.000Z']);
    expect(parseRange({ dateStart: '2026-09-24T10:00:00Z', dateEnd: '2026-09-24T12:00:00Z' })!.end.toISOString()).toBe('2026-09-24T12:00:00.000Z');
    expect(() => parseRange({ dateStart: '2026-09-24' })).toThrow('report.range_invalid');
    expect(() => parseRange({ dateStart: 'soon', dateEnd: 'later' })).toThrow('report.range_invalid');
    expect(() => parseRange({ dateStart: '2026-09-25', dateEnd: '2026-09-24' })).toThrow('report.range_order');
  });

  it('falls back to UTC for unknown zones', () => {
    expect(safeTimeZone('Mars/Olympus')).toBe('UTC');
    expect(safeTimeZone(undefined)).toBe('UTC');
    expect(safeTimeZone('Europe/Athens')).toBe('Europe/Athens');
  });
});

describe('board periods', () => {
  const thursday = new Date('2026-09-24T18:00:00Z');
  it('runs weeks Monday to Monday in local time', () => {
    const w = periodWindow('week', thursday, 'Europe/Athens');
    expect([w.start.toISOString(), w.end.toISOString()]).toEqual(['2026-09-20T21:00:00.000Z', '2026-09-27T21:00:00.000Z']);
  });
  it('runs months from the 1st, including December', () => {
    const w = periodWindow('month', thursday, 'UTC');
    expect([w.start.toISOString(), w.end.toISOString()]).toEqual(['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
    const dec = periodWindow('month', new Date('2026-12-15T12:00:00Z'), 'UTC');
    expect(dec.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('medal helpers', () => {
  it('counts the longest run of consecutive weeks', () => {
    const w = (n: number) => Date.UTC(2026, 0, 5) + n * 7 * 86_400_000;
    expect(longestWeekRun([])).toBe(0);
    expect(longestWeekRun([w(0)])).toBe(1);
    expect(longestWeekRun([w(3), w(0), w(1), w(2), w(2)])).toBe(4);
    expect(longestWeekRun([w(0), w(1), w(3), w(4), w(5)])).toBe(3);
  });
});

describe('club photo', () => {
  it('accepts real JPEG/PNG/WebP data only', () => {
    expect(assertLogo(`data:image/png;base64,${PNG}`)).toContain('image/png');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString('base64');
    expect(assertLogo(`data:image/jpeg;base64,${jpeg}`)).toContain('jpeg');
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]).toString('base64');
    expect(assertLogo(`data:image/webp;base64,${webp}`)).toContain('webp');
    expect(() => assertLogo('https://example.com/a.png')).toThrow('club.logo_invalid');
    expect(() => assertLogo(`data:image/webp;base64,${PNG}`)).toThrow('club.logo_invalid');
    expect(() => assertLogo(`data:image/png;base64,${PNG}`, 10)).toThrow('club.logo_too_large');
  });
});

describe('points typed by staff', () => {
  it('parses at most 2 decimals above zero', () => {
    expect(pointsToCents('12,5', 'x')).toBe(1_250);
    expect(pointsToCents(3, 'x')).toBe(300);
    for (const bad of ['0', '-2', '1.234', '', null]) expect(() => pointsToCents(bad, 'club.live_big_invalid')).toThrow('club.live_big_invalid');
  });
});
