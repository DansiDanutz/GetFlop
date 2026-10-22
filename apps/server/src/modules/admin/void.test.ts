import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, ledgerEntries } from '../../db/schema/index.js';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { balanceOf, couponBody, flop, openTable, startHand, supplyOf, type TableSetup } from './testkit.js';

let env: TestEnv;
let admin: Agent;
let s: TableSetup;
beforeEach(async () => {
  env = await createTestEnv({ bettingTimerSeconds: 0 });
  admin = await env.login('boss', { admin: true });
  s = await openTable(env);
});
afterEach(async () => { await env.close(); });

interface BetView { id: string; market: string; status: string; stakeCents: number; payoutCents: number; displayName: string }

/** Alice plays Rainbow 2 PTS and Any Pair 1 PTS; the flop Qc 7h 3s wins Rainbow only. */
async function settledHand(): Promise<{ handId: string; won: BetView; lost: BetView }> {
  ok(await s.alice.post('/api/player/coupon').send(couponBody(s.tableId, ['rainbow'], 200)));
  ok(await s.alice.post('/api/player/coupon').send(couponBody(s.tableId, ['any-pair'], 100)));
  const handId = await startHand(s.dealer, s.tableId);
  await flop(s.dealer, s.tableId, ['Qc', '7h', '3s']);
  const { bets } = ok(await admin.get(`/api/admin/hands/${handId}/bets`));
  return {
    handId,
    won: bets.find((b: BetView) => b.market === 'rainbow'),
    lost: bets.find((b: BetView) => b.market === 'any-pair'),
  };
}

describe('voiding a settled pick', () => {
  it('lists the hand picks with player, market, amount and status', async () => {
    const { won, lost } = await settledHand();
    expect(won).toMatchObject({ status: 'won', stakeCents: 200, payoutCents: 460, displayName: 'alice' });
    expect(lost).toMatchObject({ status: 'lost', stakeCents: 100, payoutCents: 0 });
  });

  it('returns the stake of a lost pick through the ledger', async () => {
    const { lost } = await settledHand();
    const before = await balanceOf(s.alice);
    const res = ok(await admin.post(`/api/admin/bets/${lost.id}/void`).send({ reason: 'Dealer entered the wrong cards' }));
    expect(res).toMatchObject({ bet: { status: 'voided', voidReason: 'Dealer entered the wrong cards' }, balanceChangeCents: 100, playerName: 'alice' });
    expect(await balanceOf(s.alice)).toBe(before + 100);
    const rows = await env.db.select().from(ledgerEntries).where(eq(ledgerEntries.kind, 'bet_refunded'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountCents: 100, refType: 'bet', refId: lost.id, note: 'Dealer entered the wrong cards', actorId: admin.userId });
    expect((await supplyOf(s.owner, s.clubId)).drift).toBe(0);
  });

  it('takes back the win and returns the stake of a won pick', async () => {
    const { handId, won } = await settledHand();
    const before = await balanceOf(s.alice);
    const res = ok(await admin.post(`/api/admin/bets/${won.id}/void`).send({ reason: 'Wrong flop' }));
    expect(res.balanceChangeCents).toBe(200 - 460);
    expect(await balanceOf(s.alice)).toBe(before - 460 + 200);
    const rows = await env.db.select().from(ledgerEntries).where(eq(ledgerEntries.kind, 'bet_refunded'));
    expect(rows.map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([200, 460]);
    expect((await supplyOf(s.owner, s.clubId)).drift).toBe(0);
    expect(ok(await s.owner.get('/api/inspector/wallet-drift')).driftingCount).toBe(0);

    const { hands } = ok(await admin.get(`/api/admin/hands?tableId=${s.tableId}`));
    const hand = hands.find((h: { id: string }) => h.id === handId);
    expect(hand).toMatchObject({ picks: 1, playedCents: 100, paidCents: 0, resultCents: 100 });
    expect(env.events.named('balance:updated').at(-1)).toMatchObject({ room: `user:${s.alice.userId}` });
  });

  it('writes an audit entry for the void', async () => {
    const { lost } = await settledHand();
    ok(await admin.post(`/api/admin/bets/${lost.id}/void`).send({ reason: 'Misdeal' }));
    const [entry] = await env.db.select().from(auditLog).where(and(eq(auditLog.action, 'void_bet'), eq(auditLog.targetId, lost.id)));
    expect(entry).toMatchObject({ actorId: admin.userId, clubId: s.clubId, targetType: 'bet' });
    expect(entry!.data).toMatchObject({ reason: 'Misdeal', previousStatus: 'lost', stakeCents: 100 });
  });

  it('requires a reason and refuses repeats, pending picks and unknown picks', async () => {
    const { lost } = await settledHand();
    expect(errCode(await admin.post(`/api/admin/bets/${lost.id}/void`).send({ reason: '  ' }))).toBe('admin.reason_required');
    expect(errCode(await admin.post(`/api/admin/bets/${lost.id}/void`).send({}))).toBe('admin.reason_required');
    ok(await admin.post(`/api/admin/bets/${lost.id}/void`).send({ reason: 'Misdeal' }));
    expect(errCode(await admin.post(`/api/admin/bets/${lost.id}/void`).send({ reason: 'Again' }))).toBe('admin.bet_already_voided');
    expect(errCode(await admin.post('/api/admin/bets/missing/void').send({ reason: 'x' }))).toBe('admin.bet_not_found');

    ok(await s.bob.post('/api/player/coupon').send(couponBody(s.tableId, ['rainbow'], 100)));
    const handId = await startHand(s.dealer, s.tableId);
    const { bets } = ok(await admin.get(`/api/admin/hands/${handId}/bets`));
    expect(errCode(await admin.post(`/api/admin/bets/${bets[0].id}/void`).send({ reason: 'x' }))).toBe('admin.bet_not_settled');
  });

  it('reports an unknown hand', async () => {
    expect(errCode(await admin.get('/api/admin/hands/missing/bets'))).toBe('admin.hand_not_found');
  });
});
