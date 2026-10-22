import { describe, expect, it } from 'vitest';
import {
  asList, auditActionKey, clubDay, edgeOf, fairOdds, handStatusKey, multiplierOf, oddsOf, parseOdds, pct,
  periodRange, shiftDay, toCsv, verdictKey,
} from './logic';

describe('club days and period chips', () => {
  const tz = 'Europe/Athens';

  it('gives the club day, which starts at 06:00 local time', () => {
    expect(clubDay(new Date('2026-09-24T18:00:00Z'), tz)).toBe('2026-09-24');
    expect(clubDay(new Date('2026-09-24T02:00:00Z'), tz)).toBe('2026-09-23');
  });

  it('shifts a day across month ends', () => {
    expect(shiftDay('2026-10-01', -1)).toBe('2026-09-30');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('builds the Today / 7 days / 30 days / All ranges', () => {
    const now = new Date('2026-09-24T18:00:00Z');
    expect(periodRange('today', now, tz)).toEqual({ dateStart: '2026-09-24', dateEnd: '2026-09-24', tz });
    expect(periodRange('7d', now, tz)).toEqual({ dateStart: '2026-09-18', dateEnd: '2026-09-24', tz });
    expect(periodRange('30d', now, tz)).toEqual({ dateStart: '2026-08-26', dateEnd: '2026-09-24', tz });
    expect(periodRange('all', now, tz)).toEqual({ tz });
  });
});

describe('market pricing', () => {
  it('computes the fair price and the edge', () => {
    expect(fairOdds(0.25)).toBe(3);
    expect(fairOdds(0)).toBe(0);
    expect(edgeOf(1.3, 0.4)).toBeCloseTo(0.08, 9);
    expect(edgeOf(2, 0.4)).toBeLessThan(0);
  });

  it('converts between odds and multipliers', () => {
    expect(multiplierOf(1.3)).toBe(2.3);
    expect(oddsOf(2.3)).toBe(1.3);
  });

  it('parses a typed price: above 0, at most 2 decimals, comma or dot', () => {
    expect(parseOdds('1,3')).toBe(1.3);
    expect(parseOdds(' 59 ')).toBe(59);
    expect(parseOdds('0')).toBeNull();
    expect(parseOdds('-2')).toBeNull();
    expect(parseOdds('1.234')).toBeNull();
    expect(parseOdds('abc')).toBeNull();
  });

  it('formats a share as a percentage', () => {
    expect(pct(0.0854)).toBe('8.5%');
    expect(pct(-0.19, 0)).toBe('-19%');
  });
});

describe('labels', () => {
  it('maps hand statuses to shared keys', () => {
    expect(handStatusKey('settled')).toBe('status_settled');
    expect(handStatusKey('cancelled')).toBe('status_cancelled');
    expect(handStatusKey('betting_open')).toBe('picks_open');
    expect(handStatusKey('betting_closed')).toBe('picks_closed');
    expect(handStatusKey('pending')).toBe('status_waiting');
  });

  it('maps audit actions and verdicts to keys', () => {
    expect(auditActionKey('deactivate_user')).toBe('audit_action_deactivate_user');
    expect(auditActionKey('weird.action-x')).toBe('audit_action_weird_action_x');
    expect(verdictKey('too_few')).toBe('admin_verdict_too_few');
  });
});

describe('CSV export', () => {
  it('quotes separators and neutralises spreadsheet formulas', () => {
    const csv = toCsv(['name', 'note', 'amount'], [['Ann, B', 'say "hi"', -12.5], ['=SUM(A1)', 'line\nbreak', 3]]);
    expect(csv).toBe('name,note,amount\r\n"Ann, B","say ""hi""",-12.5\r\n\'=SUM(A1),"line\nbreak",3');
  });

  it('writes empty cells for null values', () => {
    expect(toCsv(['a', 'b'], [[null, undefined]])).toBe('a,b\r\n,');
  });
});

describe('tolerant list reading', () => {
  it('reads a list whether it is bare or wrapped', () => {
    expect(asList([1, 2], 'items')).toEqual([1, 2]);
    expect(asList({ items: [3] }, 'items')).toEqual([3]);
    expect(asList({ other: [3] }, 'items')).toEqual([]);
    expect(asList(null, 'items')).toEqual([]);
  });
});
