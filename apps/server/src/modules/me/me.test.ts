import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { grantRole, setupClub } from '../../test/fixtures.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv({ bettingTimerSeconds: 0 }); });
afterEach(async () => { await env.close(); });

interface Setup { clubId: string; owner: Agent; dealer: Agent; alice: Agent; bob: Agent; tableId: string; joinCode: string }

async function openTable(): Promise<Setup> {
  const { clubId, owner, players: [dealer, alice, bob] } = await setupClub(env, { players: ['dealer', 'alice', 'bob'], pointsEach: 100 });
  await grantRole(env, clubId, dealer!.userId, 'dealer');
  const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'Table 1', game: 'nlh' }));
  ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({ dealerId: dealer!.userId }));
  return { clubId, owner, dealer: dealer!, alice: alice!, bob: bob!, tableId: table.id, joinCode: table.joinCode };
}

const coupon = (tableId: string, markets: string[], stakeCents: number, rounds: number) =>
  ({ tableId, rounds, selections: markets.map((market) => ({ market, stakeCents })) });

async function playHand(s: Setup, cards: [string, string, string]): Promise<void> {
  ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/start-hand`));
  ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/enter-flop`).send({ card1: cards[0], card2: cards[1], card3: cards[2] }));
}

describe('GET /player/my-games', () => {
  it('lists live and recent coupons with committed, won and still-riding figures', async () => {
    const s = await openTable();
    ok(await s.alice.post('/api/player/coupon').send(coupon(s.tableId, ['rainbow'], 200, 3)));
    ok(await s.alice.post('/api/player/coupon').send(coupon(s.tableId, ['any-pair'], 100, 1)));
    await playHand(s, ['Qc', '7h', '3s']); // rainbow wins (×2.3), any-pair loses

    const data = ok(await s.alice.get('/api/player/my-games'));
    expect(data.games).toEqual([expect.objectContaining({
      tableId: s.tableId, tableName: 'Table 1', kind: 'cash', state: 'waiting', handNumber: 1,
      liveCoupons: 1, committedCents: 600, stillAtStakeCents: 400, wonCents: 460,
    })]);
    expect(data.live).toHaveLength(1);
    expect(data.live[0]).toMatchObject({ rounds: 3, roundsSettled: 1, committedCents: 600, wonCents: 460, stillAtStakeCents: 400 });
    expect(data.recent).toHaveLength(1);
    expect(data.recent[0]).toMatchObject({ status: 'completed', rounds: 1, roundsSettled: 1, wonCents: 0, stillAtStakeCents: 0 });
    expect(data.totals).toEqual({ committedCents: 700, wonCents: 460, stillAtStakeCents: 400, liveCoupons: 1 });
  });

  it('shows the hand state of each table with coupons riding', async () => {
    const s = await openTable();
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/start-hand`));
    ok(await s.alice.post('/api/player/coupon').send(coupon(s.tableId, ['rainbow'], 100, 2)));
    expect(ok(await s.alice.get('/api/player/my-games')).games[0]).toMatchObject({ state: 'picks_open', handNumber: 1 });
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/no-more-bets`));
    expect(ok(await s.alice.get('/api/player/my-games')).games[0]).toMatchObject({ state: 'picks_closed' });
  });

  it('is empty for a member who has not played, and only shows the caller\'s coupons', async () => {
    const s = await openTable();
    ok(await s.alice.post('/api/player/coupon').send(coupon(s.tableId, ['rainbow'], 100, 2)));
    expect(ok(await s.bob.get('/api/player/my-games'))).toMatchObject({ games: [], live: [], recent: [] });
  });

  it('requires a club membership', async () => {
    const s = await openTable();
    const stranger = await env.login('stranger');
    expect(errCode(await stranger.get('/api/player/my-games').set('X-Club-Id', s.clubId))).toBe('club.access_denied');
    expect(errCode(await stranger.get('/api/player/my-games'))).toBe('club.context_required');
    expect(errCode(await request(env.url).get('/api/player/my-games'))).toBe('auth.required');
  });
});

describe('GET /player/history', () => {
  it('returns coupons, settled picks and wallet movements with player labels', async () => {
    const s = await openTable();
    ok(await s.alice.post('/api/player/coupon').send(coupon(s.tableId, ['rainbow', 'any-pair'], 100, 1)));
    await playHand(s, ['Qc', '7h', '3s']);

    const data = ok(await s.alice.get('/api/player/history?limit=30'));
    expect(data.coupons).toHaveLength(1);
    expect(data.coupons[0]).toMatchObject({ status: 'completed', committedCents: 200, wonCents: 230 });
    expect(data.bets.map((b: { market: string; status: string }) => [b.market, b.status]).sort())
      .toEqual([['any-pair', 'lost'], ['rainbow', 'won']]);
    expect(data.bets[0]).toMatchObject({ tableName: 'Table 1', handNumber: 1, flop: ['Qc', '7h', '3s'] });

    const moves = data.transactions.map((t: { kind: string; label: string; amountCents: number }) => [t.kind, t.label, t.amountCents]);
    expect(moves).toEqual([
      ['bet_won', 'win', 230],
      ['coupon_placed', 'coupon', -200],
      ['deposit', 'points_received', 10_000],
    ]);
    expect(data.transactions[0]).toMatchObject({ balanceAfterCents: 10_030 });
    expect(data.summary).toMatchObject({ committedCents: 200, wonCents: 230, netTodayCents: 30, ridingCents: 0 });
  });

  it('labels request approvals, returns and refunds from the player side', async () => {
    const s = await openTable();
    ok(await s.alice.post('/api/player/cashout-request').send({ amountCents: 1_000 }));
    const { cashouts } = ok(await s.alice.get('/api/player/requests'));
    ok(await s.owner.post(`/api/inspector/request/${cashouts[0].id}/approve`).send({}));
    ok(await s.alice.post('/api/player/coupon').send(coupon(s.tableId, ['rainbow'], 100, 2)));
    ok(await s.owner.put(`/api/inspector/table/${s.tableId}/close`));

    const labels = ok(await s.alice.get('/api/player/history')).transactions
      .map((t: { label: string; amountCents: number }) => [t.label, t.amountCents]);
    expect(labels).toEqual([
      ['coupon_voided', 200],
      ['coupon', -200],
      ['points_returned', -1_000],
      ['points_received', 10_000],
    ]);
  });

  it('respects the limit and validates it', async () => {
    const s = await openTable();
    for (let i = 0; i < 3; i++) ok(await s.alice.post('/api/player/coupon').send(coupon(s.tableId, ['rainbow'], 100, 1)));
    const data = ok(await s.alice.get('/api/player/history?limit=2'));
    expect(data.coupons).toHaveLength(2);
    expect(data.transactions).toHaveLength(2);
    expect(errCode(await s.alice.get('/api/player/history?limit=abc'))).toBe('validation.invalid');
  });
});

describe('GET /tables/by-code/:code', () => {
  it('returns the table and its club card to anyone, with the caller\'s membership', async () => {
    const s = await openTable();
    const anon = ok(await request(env.url).get(`/api/tables/by-code/${s.joinCode.toLowerCase()}`));
    expect(anon).toMatchObject({
      table: { id: s.tableId, name: 'Table 1', kind: 'cash', status: 'open', activeHandStatus: null, activeHandNumber: null },
      club: { id: s.clubId, name: 'Sharks Imperial' },
      membershipStatus: null,
    });
    expect(ok(await s.alice.get(`/api/tables/by-code/${s.joinCode}`)).membershipStatus).toBe('active');
    const stranger = await env.login('stranger');
    expect(ok(await stranger.get(`/api/tables/by-code/${s.joinCode}`)).membershipStatus).toBeNull();

    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/start-hand`));
    expect(ok(await request(env.url).get(`/api/tables/by-code/${s.joinCode}`)).table)
      .toMatchObject({ activeHandStatus: 'betting_open', activeHandNumber: 1 });
  });

  it('rejects unknown or malformed codes', async () => {
    await openTable();
    expect(errCode(await request(env.url).get('/api/tables/by-code/NOPE1234'))).toBe('table.not_found');
    expect(errCode(await request(env.url).get('/api/tables/by-code/%3Cx%3E'))).toBe('table.not_found');
  });
});
