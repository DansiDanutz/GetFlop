import { describe, expect, it } from 'vitest';
import { AppError } from '../../http/errors.js';
import { validateSendAt, validateText } from './compose.js';
import { parsePhoto } from './photo.js';
import { escapeXml, wrap } from './posters/svg.js';
import { pngDataUrl } from './test-helpers.js';
import { parseTz, startOfMonth, startOfNextMonth } from './time.js';

const code = (fn: () => unknown): string => {
  try { fn(); } catch (err) { return err instanceof AppError ? err.code : String(err); }
  return 'no error';
};

describe('time helpers', () => {
  it('validates timezones', () => {
    expect(parseTz(undefined)).toBe('UTC');
    expect(parseTz('Europe/Athens')).toBe('Europe/Athens');
    expect(code(() => parseTz('Nowhere/City'))).toBe('validation.invalid');
    expect(code(() => parseTz(42))).toBe('validation.invalid');
  });

  it('finds the local start of the month across DST', () => {
    const now = new Date('2026-10-30T12:00:00Z'); // Athens switches to UTC+2 on 25 Oct
    expect(startOfMonth(now, 'Europe/Athens').toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(startOfNextMonth(now, 'Europe/Athens').toISOString()).toBe('2026-10-31T22:00:00.000Z');
    expect(startOfMonth(now, 'UTC').toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(startOfNextMonth(new Date('2026-12-10T00:00:00Z'), 'UTC').toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(startOfMonth(new Date('2026-03-15T00:00:00Z'), 'America/New_York').toISOString()).toBe('2026-03-01T05:00:00.000Z');
  });
});

describe('compose validation', () => {
  const now = new Date('2026-09-24T18:00:00Z');
  it('trims text and treats an empty title as none', () => {
    expect(validateText('  ', ' hi ')).toEqual({ title: null, body: 'hi' });
    expect(code(() => validateText(null, null))).toBe('messages.body_required');
  });
  it('accepts a send time between 1 minute and 30 days ahead', () => {
    expect(validateSendAt(null, now)).toBeNull();
    expect(validateSendAt('', now)).toBeNull();
    expect(validateSendAt('2026-09-24T18:01:00Z', now)?.toISOString()).toBe('2026-09-24T18:01:00.000Z');
    expect(code(() => validateSendAt('2026-09-24T18:00:59Z', now))).toBe('messages.schedule_past');
    expect(code(() => validateSendAt('2026-10-24T18:00:01Z', now))).toBe('messages.schedule_too_far');
  });
});

describe('photo validation', () => {
  it('checks the content matches the declared type', () => {
    expect(parsePhoto(pngDataUrl()).mime).toBe('image/png');
    const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64')}`;
    expect(parsePhoto(jpeg).mime).toBe('image/jpeg');
    const webp = `data:image/webp;base64,${Buffer.from('RIFF\0\0\0\0WEBPVP8 ').toString('base64')}`;
    expect(parsePhoto(webp).mime).toBe('image/webp');
    expect(code(() => parsePhoto(jpeg.replace('jpeg', 'png')))).toBe('messages.photo_invalid');
    expect(code(() => parsePhoto('data:image/svg+xml;base64,PHN2Zz4='))).toBe('messages.photo_invalid');
  });
});

describe('poster text', () => {
  it('escapes XML and wraps long lines', () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;');
    const lines = wrap('one two three four five six seven eight nine ten', 100, 1000);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.length <= Math.floor(1000 / 52))).toBe(true);
    expect(wrap('first\nsecond', 100, 2000)).toEqual(['first', 'second']);
    expect(wrap('x'.repeat(50), 100, 1000).every((l) => l.length <= 19)).toBe(true);
  });
});
