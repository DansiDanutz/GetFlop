import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { setupClub } from '../../test/fixtures.js';
import { starSupply } from './stars.js';
import { arenaWorld, BLANK, dealWith, picks, STAR, stars } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { vi.unstubAllEnvs(); await env.close(); });

describe('entering the Arena', () => {
  it('grants 2,000 ★ once and joins without approval, outside every club list', async () => {
    const alice = await env.login('alice');
    expect(ok(await alice.get('/api/arena/summary'))).toMatchObject({ open: true, entered: false, balanceCents: 0 });
    const first = ok(await alice.post('/api/arena/enter').send({}));
    expect(first).toMatchObject({ kind: 'welcome', grantedCents: 2_000 * STAR, balanceCents: 2_000 * STAR });
    const again = ok(await alice.post('/api/arena/enter').send({}));
    expect(again).toMatchObject({ kind: null, grantedCents: 0, balanceCents: 2_000 * STAR });
    expect(ok(await alice.get('/api/arena/summary'))).toMatchObject({ entered: true, stars: 2_000 * STAR, refill: { ready: false } });
    expect(ok(await alice.get('/api/clubs/mine')).clubs).toEqual([]);
    expect(errCode(await alice.get('/api/clubs/find/0000000'))).toBe('club.not_found');
    expect(env.events.named('balance:updated').at(-1)!.payload).toMatchObject({ balanceCents: 2_000 * STAR, unit: 'stars' });
  });

  it('offers a free refill under 500 ★, at most once every 24 hours', async () => {
    const { ids, players: [alice] } = await arenaWorld(env);
    ok(await alice!.post('/api/arena/coupon').send(picks(ids.tableId, ['rainbow'], 1_600 * STAR)));
    await dealWith(env, ids, ['Ah', 'Ad', 'Kh']);
    expect(await stars(alice!)).toBe(400 * STAR);
    expect(ok(await alice!.get('/api/arena/bar')).refill).toMatchObject({ ready: true, amountCents: 1_600 * STAR, under: 500 * STAR });

    const refill = ok(await alice!.post('/api/arena/enter').send({}));
    expect(refill).toMatchObject({ kind: 'refill', grantedCents: 1_600 * STAR, balanceCents: 2_000 * STAR });

    env.clock.advance(60_000);
    ok(await alice!.post('/api/arena/coupon').send(picks(ids.tableId, ['rainbow'], 1_900 * STAR)));
    await dealWith(env, ids, ['Ah', 'Ad', 'Kh']);
    const waiting = ok(await alice!.post('/api/arena/enter').send({}));
    expect(waiting).toMatchObject({ kind: null, refill: { ready: false } });
    expect(waiting.refill.nextAt).toBe(new Date(env.clock.now().getTime() - 60_000 + 86_400_000).toISOString());

    env.clock.advance(86_400_000);
    expect(ok(await alice!.post('/api/arena/enter').send({}))).toMatchObject({ kind: 'refill', grantedCents: 1_900 * STAR });
  });

  it('refuses everything while the Arena is closed', async () => {
    vi.stubEnv('ARENA_OPEN', '0');
    const alice = await env.login('alice');
    expect(ok(await alice.get('/api/arena/summary'))).toMatchObject({ open: false });
    expect(errCode(await alice.post('/api/arena/enter').send({}))).toBe('arena.closed');
  });
});

describe('playing with Stars', () => {
  it('has no per-pick, per-coupon or per-market cap other than the balance', async () => {
    const { ids, players: [alice] } = await arenaWorld(env);
    // 150 ★ on ×170 over 10 flops: far above any club limit (5 PTS on ×170, 200 PTS per coupon).
    const placed = ok(await alice!.post('/api/arena/coupon').send(picks(ids.tableId, ['trips-or-sf'], 150 * STAR, 10)));
    expect(placed).toMatchObject({ unit: 'stars', totalCommitmentCents: 1_500 * STAR, balanceCents: 500 * STAR, playsCurrentHand: true });
    expect(errCode(await alice!.post('/api/arena/coupon').send(picks(ids.tableId, ['rainbow'], 501 * STAR)))).toBe('coupon.insufficient_balance');
    expect(errCode(await alice!.post('/api/arena/coupon').send(picks(ids.tableId, ['rainbow'], 5 * STAR)))).toBe('coupon.min_stake');
    expect(errCode(await alice!.post('/api/arena/coupon').send(picks(ids.tableId, ['rainbow'], 10 * STAR, 21)))).toBe('coupon.max_rounds_table');
  });

  it('settles picks in Stars, pays stake × multiplier and always adds up', async () => {
    const { ids, players: [alice, bob] } = await arenaWorld(env, ['alice', 'bob']);
    ok(await alice!.post('/api/arena/coupon').send(picks(ids.tableId, ['any-pair', 'pair-aces'], 100 * STAR, 2)));
    ok(await bob!.post('/api/arena/coupon').send(picks(ids.tableId, ['rainbow'], 200 * STAR)));
    const info = await dealWith(env, ids, ['Ah', 'Ad', 'Kh']);
    expect(info.matchingSlugs).toEqual(expect.arrayContaining(['any-pair', 'pair-aces']));
    // Alice: −400 committed, + 100×5 + 100×60 on flop one.
    expect(await stars(alice!)).toBe(2_000 * STAR - 400 * STAR + 500 * STAR + 6_000 * STAR);
    expect(await stars(bob!)).toBe(1_800 * STAR);
    const settled = env.events.named('hand:settled').at(-1)!.payload as { winners: unknown[]; losers: unknown[] };
    expect(settled.winners).toHaveLength(2);
    expect(settled.losers).toHaveLength(1);

    await dealWith(env, ids, BLANK);
    const [coupon] = ok(await alice!.get('/api/arena/coupons')).coupons;
    expect(coupon).toMatchObject({ unit: 'stars', status: 'completed', roundsSettled: 2, wonCents: 6_500 * STAR });
    const draws = ok(await alice!.get(`/api/arena/coupon/${coupon.id}/draws`));
    expect(draws.draws).toHaveLength(2);
    expect(await starSupply(env.db)).toMatchObject({ riding: 0, drift: 0, issued: 4_000 * STAR });
  });

  it('keeps the Arena apart from clubs', async () => {
    const { clubId, players: [carol] } = await setupClub(env, { players: ['carol'], pointsEach: 100 });
    const { ids } = await arenaWorld(env, ['dave']);
    const { table } = ok(await (await env.login('owner')).post('/api/inspector/table').set('X-Club-Id', clubId).send({ name: 'T1' }));
    expect(errCode(await carol!.post('/api/arena/coupon').send(picks(ids.tableId, ['rainbow'], 10 * STAR)))).toBe('arena.enter_failed');
    ok(await carol!.post('/api/arena/enter').send({}));
    expect(errCode(await carol!.post('/api/arena/coupon').send(picks(table.id, ['rainbow'], 10 * STAR)))).toBe('arena.not_a_club');
    ok(await carol!.post('/api/arena/coupon').send(picks(ids.tableId, ['rainbow'], 10 * STAR)));
    // Club Points untouched; the club list still shows only the real club.
    expect(ok(await carol!.get('/api/player/balance')).balanceCents).toBe(10_000);
    expect(ok(await carol!.get('/api/clubs/mine')).clubs.map((c: { id: string }) => c.id)).toEqual([clubId]);
  });
});
