import { describe, expect, it } from 'vitest';
import { badgeCount, historyLabels, pendingGroups, returnUncovered, stockShort, type PointsRequest } from './requests';

const req = (id: string, kind: 'load' | 'cashout', createdAt: string, extra: Partial<PointsRequest> = {}): PointsRequest => ({
  id, userId: `u-${id}`, kind, amountCents: 500, status: 'pending', createdAt, username: id, displayName: null, ...extra,
});

describe('pending requests', () => {
  const pending = {
    reloads: [req('b', 'load', '2026-09-24T10:05:00Z'), req('a', 'load', '2026-09-24T10:00:00Z')],
    cashouts: [req('c', 'cashout', '2026-09-24T09:00:00Z')],
    dealerSits: [{ id: 's', tableId: 't', tableName: 'Main', dealerId: 'd', dealerName: 'Dina', createdAt: '2026-09-24T11:00:00Z' }],
    myStock: 300,
  };
  const joins = [{ membershipId: 'm', userId: 'u', username: 'zoe', displayName: null, createdAt: '2026-09-24T08:00:00Z' }];

  it('groups Points in / out / join / dealer seat, oldest first', () => {
    const groups = pendingGroups(pending, joins);
    expect(groups.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
      ['points_in', ['a', 'b']], ['points_out', ['c']], ['join', ['m']], ['dealer_sit', ['s']],
    ]);
  });

  it('drops empty groups and copes with a server without dealer sits', () => {
    expect(pendingGroups({ reloads: [], cashouts: [], myStock: null }, []).length).toBe(0);
    expect(badgeCount({ reloads: [], cashouts: [req('x', 'cashout', '2026-09-24T09:00:00Z')], myStock: null }, undefined)).toBe(1);
  });

  it('counts the badge across every kind', () => {
    expect(badgeCount(pending, joins)).toBe(5);
  });

  it('warns when a return is no longer covered, or the stock is short', () => {
    expect(returnUncovered(req('r', 'cashout', '', { balanceCents: 400 }))).toBe(true);
    expect(returnUncovered(req('r', 'cashout', ''))).toBe(false);
    expect(stockShort(req('l', 'load', ''), 300)).toBe(true);
    expect(stockShort(req('l', 'load', ''), null)).toBe(false);
  });

  it('labels history rows', () => {
    expect(historyLabels(req('h', 'cashout', '', { status: 'approved' }))).toEqual({ typeKey: 'insp_req_type_cashout', statusKey: 'insp_req_status_approved' });
  });
});
