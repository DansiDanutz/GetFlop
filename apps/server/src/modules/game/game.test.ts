import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { grantRole, setupClub } from '../../test/fixtures.js';
import { closeExpiredBetting } from './hands.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv({ bettingTimerSeconds: 30 }); });
afterEach(async () => { await env.close(); });

interface Setup { clubId: string; owner: Agent; dealer: Agent; alice: Agent; bob: Agent; tableId: string }

async function openTable(): Promise<Setup> {
  const { clubId, owner, players: [dealer, alice, bob] } = await setupClub(env, { players: ['dealer', 'alice', 'bob'], pointsEach: 100 });
  await grantRole(env, clubId, dealer!.userId, 'dealer');
  const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'Table 1', game: 'nlh' }));
  ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({ dealerId: dealer!.userId }));
  return { clubId, owner, dealer: dealer!, alice: alice!, bob: bob!, tableId: table.id };
}

const balance = async (a: Agent) => ok(await a.get('/api/player/balance')).balanceCents as number;
const coupon = (tableId: string, markets: string[], stakeCents: number, rounds: number) =>
  ({ tableId, rounds, selections: markets.map((market) => ({ market, stakeCents })) });

describe('the hand and coupon loop', () => {
  it('plays a full evening and always adds up', async () => {
    const { clubId, owner, dealer, alice, bob, tableId } = await openTable();

    // Hand 1: picks open, Alice plays Rainbow 2 PTS for 3 flops — it plays this hand.
    const started = ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`));
    expect(started).toMatchObject({ hand: { handNumber: 1, status: 'betting_open' }, bettingTimerSeconds: 30 });
    const placed = ok(await alice.post('/api/player/coupon').send(coupon(tableId, ['rainbow'], 200, 3)));
    expect(placed).toMatchObject({ totalCommitmentCents: 600, balanceCents: 9_400, playsCurrentHand: true });

    ok(await dealer.post(`/api/dealer/table/${tableId}/no-more-bets`));
    // Bob buys after picks closed: his coupon starts from the next hand.
    expect(ok(await bob.post('/api/player/coupon').send(coupon(tableId, ['any-pair', 'has-ace'], 100, 2))).playsCurrentHand).toBe(false);

    const settled = ok(await dealer.post(`/api/dealer/table/${tableId}/enter-flop`).send({ card1: 'Qc', card2: '7h', card3: '3s' }));
    expect(settled.matchingSlugs).toEqual(['rainbow']);
    expect(settled.hand).toMatchObject({ totalBets: 1, winningBets: 1, totalWageredCents: 200, totalPaidOutCents: 460 });
    expect(await balance(alice)).toBe(9_400 + 460);
    const settledEvent = env.events.named('hand:settled').at(-1)!.payload as { winners: unknown[] };
    expect(settledEvent.winners).toHaveLength(1);

    // Hand 2 is cancelled: no flop used, nothing moves.
    ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`));
    ok(await dealer.post(`/api/dealer/table/${tableId}/cancel-hand`));

    // Hand 3: a paired flop. Alice's round 2 loses; Bob wins Any Pair.
    ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`));
    ok(await dealer.post(`/api/dealer/table/${tableId}/enter-flop`).send({ card1: '7h', card2: '7d', card3: '2h' }));
    expect(await balance(bob)).toBe(10_000 - 400 + 500);

    const [live] = ok(await alice.get('/api/player/coupons?status=live')).coupons;
    expect(live).toMatchObject({ roundsSettled: 2, rounds: 3, wonCents: 460, stillAtStakeCents: 200 });
    const draws = ok(await alice.get(`/api/player/coupon/${live.id}/draws`));
    expect(draws.draws.map((d: { handNumber: number; picks: { status: string }[] }) => [d.handNumber, d.picks[0]!.status]))
      .toEqual([[1, 'won'], [2, 'refunded'], [3, 'lost']]);

    // Closing the table refunds unplayed rounds: Alice 1 × 2 PTS, Bob 1 × 2 PTS.
    const preview = ok(await owner.get(`/api/inspector/table/${tableId}/close-preview`));
    expect(preview).toEqual({ hasActiveHand: false, liveCoupons: 2, refundCents: 400 });
    ok(await owner.put(`/api/inspector/table/${tableId}/close`));
    expect(await balance(alice)).toBe(9_400 + 460 + 200);
    expect(await balance(bob)).toBe(10_000 - 400 + 500 + 200);
    expect(ok(await alice.get('/api/player/coupons')).coupons[0].status).toBe('voided');

    const supply = ok(await owner.get(`/api/clubs/${clubId}/points`));
    expect(supply).toMatchObject({ riding: 0, drift: 0, issued: 30_000 });
    expect(ok(await owner.get('/api/inspector/wallet-drift')).driftingCount).toBe(0);
  });

  it('completes a coupon after its last flop', async () => {
    const { dealer, alice, tableId } = await openTable();
    ok(await alice.post('/api/player/coupon').send(coupon(tableId, ['rainbow'], 100, 1)));
    ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`));
    ok(await dealer.post(`/api/dealer/table/${tableId}/enter-flop`).send({ card1: 'Ah', card2: 'Ad', card3: 'Kh' }));
    expect(ok(await alice.get('/api/player/coupons')).coupons[0]).toMatchObject({ status: 'completed', wonCents: 0 });
    expect(env.events.named('coupon:completed')).toHaveLength(1);
  });

  it('locks the multiplier at placement', async () => {
    const { dealer, alice, tableId } = await openTable();
    ok(await alice.post('/api/player/coupon').send(coupon(tableId, ['rainbow'], 100, 1)));
    const { betTypes } = await import('../../db/schema/index.js');
    await env.db.update(betTypes).set({ multiplierX100: 200 });
    ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`));
    ok(await dealer.post(`/api/dealer/table/${tableId}/enter-flop`).send({ card1: 'Qc', card2: '7h', card3: '3s' }));
    expect(await balance(alice)).toBe(10_000 - 100 + 230);
  });

  it('closes picks automatically when the countdown ends', async () => {
    const { dealer, tableId } = await openTable();
    ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`));
    expect(await closeExpiredBetting(env.ctx)).toBe(0);
    env.clock.advance(31_000);
    expect(await closeExpiredBetting(env.ctx)).toBe(1);
    expect(ok(await dealer.get(`/api/dealer/table/${tableId}/current-hand`)).hand.status).toBe('betting_closed');
  });
});

describe('rules and refusals', () => {
  it('enforces who deals and the hand state machine', async () => {
    const { dealer, alice, owner, tableId } = await openTable();
    expect(errCode(await alice.post(`/api/dealer/table/${tableId}/start-hand`))).toBe('club.capability_missing');
    expect(errCode(await dealer.post(`/api/dealer/table/${tableId}/no-more-bets`))).toBe('hand.not_open');
    expect(errCode(await dealer.post(`/api/dealer/table/${tableId}/enter-flop`).send({ card1: 'Qc', card2: '7h', card3: '3s' })))
      .toBe('hand.not_live');
    ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`));
    expect(errCode(await dealer.post(`/api/dealer/table/${tableId}/start-hand`))).toBe('dealer.hand_live');
    expect(errCode(await dealer.post(`/api/dealer/table/${tableId}/enter-flop`).send({ card1: 'Qc', card2: 'Qc', card3: '3s' })))
      .toBe('hand.flop_invalid');
    expect(errCode(await dealer.post(`/api/dealer/table/${tableId}/leave`))).toBe('dealer.hand_live');
    expect(errCode(await owner.put(`/api/inspector/table/${tableId}/close`))).toBe('table.hand_live');
  });

  it('refuses staff play, watch-only and a dealer on their own table', async () => {
    const { clubId, owner, dealer, tableId } = await openTable();
    expect(errCode(await dealer.post('/api/player/coupon').send(coupon(tableId, ['rainbow'], 100, 1)))).toBe('club.play_staff');
    const { memberships } = await import('../../db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    await env.db.update(memberships).set({ playMode: 'watch' }).where(eq(memberships.userId, (await env.login('alice')).userId));
    const alice = await env.login('alice');
    ok(await alice.post('/api/clubs/select').send({ clubId }));
    expect(errCode(await alice.post('/api/player/coupon').send(coupon(tableId, ['rainbow'], 100, 1)))).toBe('club.play_disabled');
    // The owner may play, but not on a table they deal.
    ok(await owner.post(`/api/clubs/${clubId}/points/mint`).send({ amount: 10, reason: 'Own play' }));
    ok(await owner.post(`/api/inspector/player/${owner.userId}/load`).send({ amount: 10 }));
    ok(await owner.post('/api/player/coupon').send(coupon(tableId, ['rainbow'], 100, 1)));
  });

  it('validates coupons against the table limits and balance', async () => {
    const { alice, owner, tableId } = await openTable();
    const cases: [ReturnType<typeof coupon>, string][] = [
      [coupon(tableId, [], 100, 1), 'coupon.no_selections'],
      [coupon(tableId, ['rainbow'], 50, 1), 'coupon.min_stake'],
      [coupon(tableId, ['trips-or-sf'], 600, 1), 'coupon.max_stake_market'],
      [coupon(tableId, ['rainbow'], 100, 21), 'coupon.max_rounds_table'],
      [coupon(tableId, ['rainbow', 'any-pair'], 2_000, 10), 'coupon.over_commitment'],
      [coupon(tableId, ['any-trips'], 100, 1), 'coupon.selection_unavailable'],
      [coupon('nope', ['rainbow'], 100, 1), 'coupon.table_not_found'],
    ];
    for (const [body, code] of cases) expect(errCode(await alice.post('/api/player/coupon').send(body))).toBe(code);
    ok(await owner.put(`/api/inspector/table/${tableId}/bet-types`).send({ allowedBetTypeIds: ['rainbow'] }));
    expect(errCode(await alice.post('/api/player/coupon').send(coupon(tableId, ['any-pair'], 100, 1)))).toBe('coupon.not_on_menu_table');
    ok(await alice.post('/api/player/coupon').send(coupon(tableId, ['rainbow'], 5_000, 2)));
    expect(errCode(await alice.post('/api/player/coupon').send(coupon(tableId, ['rainbow'], 100, 1)))).toBe('coupon.insufficient_balance');
  });

  it('validates table limits and the Starter Ring Game capacity', async () => {
    const { owner, tableId } = await openTable();
    const bad = { minCents: 500, maxCents: 100, couponCapCents: 20_000 };
    expect(errCode(await owner.put(`/api/inspector/table/${tableId}/limits`).send(bad))).toBe('table.limits_max_below_min');
    const good = ok(await owner.put(`/api/inspector/table/${tableId}/limits`).send({ minCents: 50, maxCents: 500, couponCapCents: 2_000, marketMaxCents: { rainbow: 200 } }));
    expect(good.table.limits).toMatchObject({ minCents: 50, maxCents: 500, maxRounds: 20, marketMaxCents: { rainbow: 200 } });
    const { table: second } = ok(await owner.post('/api/inspector/table').send({ name: 'Table 2' }));
    expect(errCode(await owner.put(`/api/inspector/table/${second.id}/open`).send({}))).toBe('commerce.capacity_ring_games_billing');
  });

  it('lets the floor assign and unseat dealers', async () => {
    const { owner, dealer, alice, tableId } = await openTable();
    ok(await owner.post(`/api/inspector/table/${tableId}/unseat`));
    expect(env.events.named('dealer:seat').at(-1)!.payload).toMatchObject({ status: 'unseated' });
    expect(errCode(await owner.post(`/api/inspector/table/${tableId}/assign`).send({ dealerId: alice.userId }))).toBe('dealer.not_found');
    ok(await owner.post(`/api/inspector/table/${tableId}/assign`).send({ dealerId: dealer.userId }));
    expect(ok(await dealer.get('/api/dealer/tables')).tables).toHaveLength(1);
    ok(await dealer.post(`/api/dealer/table/${tableId}/leave`));
    expect(ok(await dealer.get('/api/dealer/available-tables')).tables).toHaveLength(1);
    ok(await dealer.post(`/api/dealer/table/${tableId}/sit`));
  });
});
