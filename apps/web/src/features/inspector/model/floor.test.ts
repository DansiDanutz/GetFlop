import { describe, expect, it } from 'vitest';
import { alertView, duration, groupChip, groupTables, splitClosed, type FloorTable } from './floor';

const table = (id: string, group: FloorTable['group']): FloorTable => ({
  id, name: id, kind: 'cash', status: 'open', group, dealerId: null, dealerName: null, isAutoDeal: false, isSimulation: false,
  createdAt: '', lastHandAt: null, totalHands: 0, activeHandStatus: null, activeHandNumber: null, liveCoupons: 0,
  couponExposureCents: 0, joinCode: 'ABCD', game: 'nlh', featured: false, tournamentId: null, tournamentName: null,
});

describe('groupTables', () => {
  it('orders groups READY → NO DEALER → DEALING → WAITING → AUTO → CLOSED → OTHER and drops empty ones', () => {
    const groups = groupTables([table('c', 'closed'), table('d', 'dealing'), table('r', 'ready'), table('d2', 'dealing'), table('o', 'other')]);
    expect(groups.map((g) => [g.group, g.tables.map((t) => t.id)])).toEqual([
      ['ready', ['r']], ['dealing', ['d', 'd2']], ['closed', ['c']], ['other', ['o']],
    ]);
  });

  it('folds closed tables apart', () => {
    const { visible, closed } = splitClosed(groupTables([table('c', 'closed'), table('w', 'waiting')]));
    expect(visible.map((g) => g.group)).toEqual(['waiting']);
    expect(closed?.tables).toHaveLength(1);
    expect(splitClosed(groupTables([table('w', 'waiting')])).closed).toBeNull();
  });

  it('gives each group a chip', () => {
    expect(groupChip('no_dealer')).toEqual({ cls: 'closed', key: 'insp_group_no_dealer' });
  });
});

describe('duration', () => {
  it('reads minutes, hours and minutes under 48 h, then days', () => {
    expect(duration(8 * 60_000 + 59_000)).toEqual({ key: 'insp_dur_min', params: { n: 8 } });
    expect(duration(3 * 3_600_000 + 5 * 60_000)).toEqual({ key: 'insp_dur_hm', params: { h: 3, m: 5 } });
    expect(duration(47 * 3_600_000)).toEqual({ key: 'insp_dur_hm', params: { h: 47, m: 0 } });
    expect(duration(49 * 3_600_000)).toEqual({ key: 'insp_dur_days', params: { n: 2 } });
    expect(duration(-5)).toEqual({ key: 'insp_dur_min', params: { n: 0 } });
  });
});

describe('alertView', () => {
  it('maps each alert to its text key and action', () => {
    expect(alertView({ severity: 'danger', code: 'requests_waiting', params: { n: 2 } }))
      .toEqual({ key: 'insp_alert_requests_waiting', params: { n: 2 }, action: 'open_requests' });
    expect(alertView({ severity: 'danger', code: 'no_dealer', params: { table: 'Main' }, tableId: 't' }).action).toBe('assign_dealer');
    expect(alertView({ severity: 'attention', code: 'drift_unknown', params: {} }).action).toBeNull();
    expect(alertView({ severity: 'waiting', code: 'tournament_soon', params: {} }).action).toBe('open_tournaments');
  });
});
