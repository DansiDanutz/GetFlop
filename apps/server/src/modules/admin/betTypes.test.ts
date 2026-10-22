import { MARKETS } from '@getflop/engine';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../../db/schema/index.js';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { balanceOf, couponBody, flop, openTable, startHand } from './testkit.js';

let env: TestEnv;
let admin: Agent;
beforeEach(async () => {
  env = await createTestEnv({ bettingTimerSeconds: 0 });
  admin = await env.login('boss', { admin: true });
});
afterEach(async () => { await env.close(); });

interface BetTypeView { slug: string; payoutOdds: number; multiplier: number; probability: number; edge: number; isActive: boolean; liveCoupons: number; unresolvedCents: number }
const find = (list: BetTypeView[], slug: string) => list.find((b) => b.slug === slug)!;

describe('market matrix', () => {
  it('lists every market with price, chance, fair price and edge', async () => {
    const { betTypes } = ok(await admin.get('/api/admin/bet-types'));
    expect(betTypes).toHaveLength(MARKETS.length);
    const rainbow = find(betTypes, 'rainbow');
    expect(rainbow).toMatchObject({ name: 'Rainbow', payoutOdds: 1.3, multiplier: 2.3, isActive: true, liveCoupons: 0, unresolvedCents: 0 });
    expect(rainbow.probability).toBeCloseTo(0.397647, 5);
    expect(rainbow.edge).toBeCloseTo(0.0854, 3);
    expect(find(betTypes, 'any-trips').isActive).toBe(false);
  });

  it('changes a price for new coupons while live coupons keep theirs', async () => {
    const s = await openTable(env);
    ok(await s.alice.post('/api/player/coupon').send(couponBody(s.tableId, ['rainbow'], 200, 3)));

    const res = ok(await admin.put('/api/admin/bet-types/rainbow').send({ payout_odds: 1.4 }));
    expect(res.betType).toMatchObject({ slug: 'rainbow', payoutOdds: 1.4, multiplier: 2.4 });
    expect(res.previous).toMatchObject({ payoutOdds: 1.3, isActive: true });
    expect(res.impact).toEqual({ liveCoupons: 1, unresolvedCents: 600, unresolvedByUnit: { points: 600 } });
    expect(res.negativeEdge).toBe(false);

    ok(await s.bob.post('/api/player/coupon').send(couponBody(s.tableId, ['rainbow'], 200, 1)));
    const aliceBefore = await balanceOf(s.alice);
    const bobBefore = await balanceOf(s.bob);
    await startHand(s.dealer, s.tableId);
    await flop(s.dealer, s.tableId, ['Qc', '7h', '3s']);
    expect(await balanceOf(s.alice)).toBe(aliceBefore + 460);
    expect(await balanceOf(s.bob)).toBe(bobBefore + 480);

    const [entry] = await env.db.select().from(auditLog).where(eq(auditLog.action, 'bet_type_update'));
    expect(entry).toMatchObject({ actorId: admin.userId, targetType: 'bet_type', targetId: 'rainbow' });
    expect(entry!.data).toMatchObject({ before: { multiplierX100: 230 }, after: { multiplierX100: 240 } });
  });

  it('accepts the price as a multiplier and flags a negative edge', async () => {
    const res = ok(await admin.put('/api/admin/bet-types/rainbow').send({ multiplier: 3 }));
    expect(res.betType.payoutOdds).toBe(2);
    expect(res.negativeEdge).toBe(true);
    expect(res.betType.edge).toBeLessThan(0);
  });

  it('takes a market off the board so it cannot be picked', async () => {
    const s = await openTable(env);
    const res = ok(await admin.put('/api/admin/bet-types/any-pair').send({ is_active: false }));
    expect(res.betType.isActive).toBe(false);
    expect(errCode(await s.alice.post('/api/player/coupon').send(couponBody(s.tableId, ['any-pair'], 100)))).toBe('coupon.selection_unavailable');
  });

  it('validates the price and the market', async () => {
    const put = (slug: string, body: Record<string, unknown>) => admin.put(`/api/admin/bet-types/${slug}`).send(body);
    expect(errCode(await put('rainbow', { payout_odds: 0 }))).toBe('admin.payout_invalid');
    expect(errCode(await put('rainbow', { payout_odds: -1 }))).toBe('admin.payout_invalid');
    expect(errCode(await put('rainbow', { multiplier: 1 }))).toBe('admin.payout_invalid');
    expect(errCode(await put('rainbow', { payout_odds: 1.3, probability: 1.5 }))).toBe('admin.probability_invalid');
    expect(errCode(await put('rainbow', {}))).toBe('admin.payout_invalid');
    expect(errCode(await put('nope', { payout_odds: 2 }))).toBe('admin.bet_type_not_found');
  });
});
