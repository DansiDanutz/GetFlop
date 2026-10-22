import { describe, expect, it } from 'vitest';
import { buildAlerts, classifyTable, IDLE_ALERT_MS, type FloorRow } from './floor.js';

const NOW = new Date('2026-09-24T18:00:00Z');
const MIN = 60_000;

const row = (over: Partial<FloorRow> = {}): FloorRow => ({
  id: 't1', name: 'Main', kind: 'cash', status: 'open', dealerId: 'd1', dealerName: 'Dina', isAutoDeal: false,
  isSimulation: false, createdAt: new Date(NOW.getTime() - 30 * 86_400_000), lastHandAt: new Date(NOW.getTime() - MIN),
  totalHands: 10, activeHandStatus: null, activeHandNumber: null, liveCoupons: 0, couponExposureCents: 0, ...over,
});

describe('classifyTable', () => {
  it('puts a fresh never-played closed Ring Game in READY', () => {
    expect(classifyTable(row({ status: 'closed', dealerId: null, totalHands: 0, createdAt: new Date(NOW.getTime() - 86_400_000) }), NOW)).toBe('ready');
  });
  it('treats an old or played closed table as CLOSED', () => {
    expect(classifyTable(row({ status: 'closed', totalHands: 0 }), NOW)).toBe('closed');
    expect(classifyTable(row({ status: 'closed', totalHands: 3, createdAt: NOW }), NOW)).toBe('closed');
  });
  it('never shows simulation tables as READY', () => {
    expect(classifyTable(row({ status: 'closed', totalHands: 0, createdAt: NOW, isSimulation: true }), NOW)).toBe('closed');
  });
  it('groups open tables by dealer and hand', () => {
    expect(classifyTable(row({ dealerId: null }), NOW)).toBe('no_dealer');
    expect(classifyTable(row({ activeHandStatus: 'betting_open', activeHandNumber: 4 }), NOW)).toBe('dealing');
    expect(classifyTable(row(), NOW)).toBe('waiting');
    expect(classifyTable(row({ dealerId: null, isAutoDeal: true, activeHandStatus: 'betting_open' }), NOW)).toBe('auto');
  });
  it('falls back to OTHER', () => {
    expect(classifyTable(row({ status: 'weird' }), NOW)).toBe('other');
  });
});

describe('buildAlerts', () => {
  const base = { levelLocked: false, pendingPoints: 0, simBudgetTripped: false, drift: { ok: true as const, driftingCount: 0, worstDriftCents: 0 }, tournaments: [], now: NOW };

  it('is empty when everything is fine (ALL CLEAR)', () => {
    expect(buildAlerts({ ...base, rows: [row()] })).toEqual([]);
  });

  it('lists every condition in priority order', () => {
    const alerts = buildAlerts({
      levelLocked: true,
      pendingPoints: 2,
      simBudgetTripped: true,
      drift: { ok: true, driftingCount: 3, worstDriftCents: 450 },
      rows: [
        row({ id: 'idle', name: 'Idle', lastHandAt: new Date(NOW.getTime() - 9 * MIN) }),
        row({ id: 'nd', name: 'Nobody', dealerId: null }),
        row({ id: 'auto', isAutoDeal: true, dealerId: null }),
        row({ id: 'closed', status: 'closed', dealerId: null }),
      ],
      tournaments: [
        { id: 'tr', name: 'Friday Cup', scheduledAt: new Date(NOW.getTime() + 5 * MIN) },
        { id: 'far', name: 'Later', scheduledAt: new Date(NOW.getTime() + 11 * MIN) },
        { id: 'past', name: 'Past', scheduledAt: new Date(NOW.getTime() - MIN) },
      ],
      now: NOW,
    });
    expect(alerts.map((a) => [a.severity, a.code])).toEqual([
      ['danger', 'level_locked'],
      ['danger', 'requests_waiting'],
      ['danger', 'sim_budget'],
      ['danger', 'no_dealer'],
      ['danger', 'drift'],
      ['attention', 'idle'],
      ['waiting', 'tournament_soon'],
    ]);
    expect(alerts[1]!.params).toEqual({ n: 2 });
    expect(alerts[3]).toMatchObject({ tableId: 'nd', params: { table: 'Nobody' } });
    expect(alerts[4]!.params).toEqual({ n: 3, largest: 450 });
    expect(alerts[5]).toMatchObject({ tableId: 'idle', params: { table: 'Idle', dealer: 'Dina', minutes: 9 } });
    expect(alerts[6]).toMatchObject({ tournamentId: 'tr', params: { tournament: 'Friday Cup', minutes: 5 } });
  });

  it('flags idle exactly at 8 minutes, not before, and never with a live hand', () => {
    const at = (ms: number, over: Partial<FloorRow> = {}) =>
      buildAlerts({ ...base, rows: [row({ lastHandAt: new Date(NOW.getTime() - ms), ...over })] }).map((a) => a.code);
    expect(at(IDLE_ALERT_MS)).toEqual(['idle']);
    expect(at(IDLE_ALERT_MS - 1)).toEqual([]);
    expect(at(IDLE_ALERT_MS * 2, { activeHandStatus: 'betting_open' })).toEqual([]);
    expect(at(IDLE_ALERT_MS * 2, { isAutoDeal: true })).toEqual([]);
  });

  it('reports a drift check that could not run', () => {
    expect(buildAlerts({ ...base, drift: { ok: false }, rows: [] }).map((a) => [a.severity, a.code])).toEqual([['attention', 'drift_unknown']]);
  });
});
