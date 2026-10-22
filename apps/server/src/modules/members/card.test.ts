import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { grantRole, setupClub } from '../../test/fixtures.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

async function club() {
  const fx = await setupClub(env, { players: ['mgr', 'insp', 'dealer', 'alice', 'bob'], pointsEach: 50 });
  const [mgr, insp, dealer, alice, bob] = fx.players as [Agent, Agent, Agent, Agent, Agent];
  await grantRole(env, fx.clubId, mgr.userId, 'manager');
  await grantRole(env, fx.clubId, insp.userId, 'inspector');
  await grantRole(env, fx.clubId, dealer.userId, 'dealer');
  return { ...fx, mgr, insp, dealer, alice, bob };
}

describe('members list', () => {
  it('lists active members highest role first with balances for managers', async () => {
    const { clubId, owner, mgr, insp, dealer, alice, bob } = await club();
    const data = ok(await owner.get(`/api/clubs/${clubId}/members`));
    expect(data.actor).toMatchObject({ userId: owner.userId, roles: ['owner'] });
    expect(data.members.map((m: { username: string }) => m.username)).toEqual(['owner', 'mgr', 'insp', 'dealer', 'alice', 'bob']);
    expect(data.members[4]).toMatchObject({ userId: alice.userId, roles: [], playMode: 'play', status: 'active', balanceCents: 5_000 });
    expect(data.counts).toMatchObject({ active: 6, pending: 0, ended: 0 });
    const asInspector = ok(await insp.get(`/api/clubs/${clubId}/members`));
    expect(asInspector.members[0].balanceCents).toBeUndefined();
    expect(errCode(await dealer.get(`/api/clubs/${clubId}/members`))).toBe('members.forbidden');
    expect(errCode(await bob.get(`/api/clubs/${clubId}/members`))).toBe('members.forbidden');
    void mgr;
  });

  it('filters players, staff, roles, pending and search', async () => {
    const { clubId, owner } = await club();
    const names = async (q: string) =>
      ok(await owner.get(`/api/clubs/${clubId}/members${q}`)).members.map((m: { username: string }) => m.username);
    expect(await names('?filter=players')).toEqual(['alice', 'bob']);
    expect(await names('?filter=staff')).toEqual(['owner', 'mgr', 'insp', 'dealer']);
    expect(await names('?filter=inspector')).toEqual(['insp']);
    expect(await names('?q=ALI')).toEqual(['alice']);
    const carol = await env.login('carol');
    ok(await carol.post(`/api/clubs/${clubId}/join`).send({ source: 'invite' }));
    expect(await names('?filter=pending')).toEqual(['carol']);
    expect(errCode(await owner.get(`/api/clubs/${clubId}/members?filter=nobody`))).toBe('validation.invalid');
  });
});

describe('member card', () => {
  it('shows figures, markets, movements and coupons', async () => {
    const { clubId, owner, dealer, alice } = await club();
    const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'Table 1' }));
    ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({ dealerId: dealer.userId }));
    ok(await dealer.post(`/api/dealer/table/${table.id}/start-hand`));
    ok(await alice.post('/api/player/coupon').send({ tableId: table.id, rounds: 2, selections: [{ market: 'rainbow', stakeCents: 200 }] }));
    ok(await dealer.post(`/api/dealer/table/${table.id}/enter-flop`).send({ card1: 'Qc', card2: '7h', card3: '3s' }));
    ok(await dealer.post(`/api/dealer/table/${table.id}/start-hand`));
    ok(await dealer.post(`/api/dealer/table/${table.id}/enter-flop`).send({ card1: '7h', card2: '7d', card3: '2h' }));
    ok(await owner.post(`/api/inspector/player/${alice.userId}/withdraw`).send({ amount: 3 }));

    const card = ok(await owner.get(`/api/clubs/${clubId}/members/${alice.userId}`));
    expect(card.member).toMatchObject({ userId: alice.userId, username: 'alice', roles: [], balanceCents: 5_000 - 400 + 460 - 300 });
    expect(card.stats.all).toEqual({ hands: 2, playedCents: 400, wonCents: 460, resultCents: -60, sentOutCents: 5_000, claimedBackCents: 300 });
    expect(card.markets).toHaveLength(1);
    expect(card.markets[0]).toMatchObject({ market: 'rainbow', picks: 2, playedCents: 400, hits: 1, hitRate: 0.5 });
    expect(card.markets[0].expectedRate).toBeGreaterThan(0.39);
    expect(card.movements[0]).toMatchObject({ kind: 'withdrawal', amountCents: -300, actor: { userId: owner.userId, name: 'owner' } });
    expect(card.movements.map((m: { kind: string }) => m.kind)).toContain('bet_won');

    const { coupons, more } = ok(await owner.get(`/api/clubs/${clubId}/members/${alice.userId}/coupons`));
    expect(more).toBe(false);
    expect(coupons[0]).toMatchObject({ status: 'completed', rounds: 2, roundsSettled: 2 });
    const detail = ok(await owner.get(`/api/clubs/${clubId}/members/${alice.userId}/coupons/${coupons[0].id}`));
    expect(detail.draws).toHaveLength(2);
    expect(errCode(await owner.get(`/api/clubs/${clubId}/members/${owner.userId}/coupons/${coupons[0].id}`))).toBe('coupon.not_found');
  });

  it('filters figures by period and validates the range', async () => {
    const { clubId, owner, alice } = await club();
    const url = `/api/clubs/${clubId}/members/${alice.userId}`;
    const future = ok(await owner.get(`${url}?dateStart=2030-01-01&dateEnd=2030-01-02&tz=Europe/Athens`));
    expect(future.stats.period).toMatchObject({ sentOutCents: 0, hands: 0 });
    expect(future.stats.all.sentOutCents).toBe(5_000);
    // Ledger rows are stamped by the database clock, so use a range that surely contains "now".
    const wide = ok(await owner.get(`${url}?dateStart=2026-01-01&dateEnd=2099-12-31&tz=Europe/Athens`));
    expect(wide.stats.period.sentOutCents).toBe(5_000);
    expect(errCode(await owner.get(`${url}?dateStart=2026-09-24`))).toBe('report.range_invalid');
    expect(errCode(await owner.get(`${url}?dateStart=2026-09-25&dateEnd=2026-09-24`))).toBe('report.range_order');
  });

  it('shows inspector stock and refuses non-members', async () => {
    const { clubId, owner, insp } = await club();
    ok(await owner.post(`/api/clubs/${clubId}/points/mint`).send({ amount: 10, reason: 'Stock' }));
    ok(await owner.post(`/api/clubs/${clubId}/members/${insp.userId}/stock`).send({ direction: 'give', amount: 10 }));
    const card = ok(await owner.get(`/api/clubs/${clubId}/members/${insp.userId}`));
    expect(card.member.stockCents).toBe(1_000);
    const stranger = await env.login('stranger');
    expect(errCode(await owner.get(`/api/clubs/${clubId}/members/${stranger.userId}`))).toBe('members.not_found');
  });
});
