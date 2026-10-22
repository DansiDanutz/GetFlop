import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { balance, create, dealHand, PAIRED, pick, RAINBOW, shortEvent, tournamentWorld } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv({ bettingTimerSeconds: 0 }); });
afterEach(async () => { await env.close(); });

async function running(names: string[], over: Record<string, unknown> = {}) {
  const world = await tournamentWorld(env, names);
  const t = await create(world.owner, shortEvent(world.dealer.userId, over));
  for (const p of world.players) ok(await p.post(`/api/tournaments/${t.id}/register`));
  ok(await world.owner.post(`/api/tournaments/${t.id}/start`));
  return { ...world, t };
}

const me = async (a: Agent, id: string) => ok(await a.get(`/api/tournaments/${id}`));
const place = (a: Agent, body: ReturnType<typeof pick>) => a.post('/api/player/coupon').send(body);

describe('coupons in tournament chips', () => {
  it('applies the level, menu, draws, exposure and registration rules', async () => {
    const { t, owner, players: [alice] } = await running(['alice']);
    expect(errCode(await place(alice!, pick(t.tableId, 'rainbow', 9_000)))).toBe('coupon.min_stake');
    expect(errCode(await place(alice!, pick(t.tableId, 'any-flush', 10_000)))).toBe('coupon.not_on_menu_tournament');
    const draws = await place(alice!, pick(t.tableId, 'rainbow', 10_000, 3));
    expect(errCode(draws)).toBe('coupon.max_draws_tournament');
    expect(draws.body.error.params).toEqual({ max: 2 });
    const over = await place(alice!, pick(t.tableId, 'rainbow', 500_010));
    expect(errCode(over)).toBe('coupon.over_exposure');
    expect(over.body.error.params).toEqual({ committed: 500_010, pct: 50, stack: 1_000_000, cap: 500_000 });
    expect(errCode(await place(owner, pick(t.tableId, 'rainbow', 10_000)))).toBe('coupon.not_registered');
  });

  it('settles in chips and never touches Points', async () => {
    const { t, clubId, owner, dealer, players: [alice] } = await running(['alice']);
    const placed = ok(await place(alice!, pick(t.tableId, 'rainbow', 10_000, 2)));
    expect(placed).toMatchObject({ unit: 'chips', isTournament: true, totalCommitmentCents: 20_000, balanceCents: 980_000 });
    expect((await me(alice!, t.id)).registration).toMatchObject({ chips: 980_000, chipsInPlay: 20_000 });
    await dealHand(dealer, t.tableId, RAINBOW);
    // Rainbow pays ×2.3: 10,000 → 23,000.
    expect((await me(alice!, t.id)).registration).toMatchObject({ chips: 1_003_000, chipsInPlay: 10_000 });
    await dealHand(dealer, t.tableId, PAIRED);
    expect((await me(alice!, t.id)).registration).toMatchObject({ chips: 1_003_000, chipsInPlay: 0 });
    expect(await balance(alice!)).toBe(10_000 - 550);
    expect(ok(await owner.get(`/api/clubs/${clubId}/points`))).toMatchObject({ riding: 0, drift: 0, inTournaments: 500 });
    const chipEvents = env.events.named('tournament:chips:updated').filter((e) => e.room === `user:${alice!.userId}`);
    expect(chipEvents.at(-1)!.payload).toEqual({ tournamentId: t.id, chips: 1_003_000 });
  });

  it('moves up a level by hand number and raises the minimum', async () => {
    const { t, dealer, players: [alice] } = await running(['alice']);
    await dealHand(dealer, t.tableId, RAINBOW);
    expect(env.events.named('tournament:level:updated')).toHaveLength(0);
    await dealHand(dealer, t.tableId, RAINBOW);
    expect(env.events.named('tournament:level:updated').at(-1)!.payload)
      .toEqual({ tournamentId: t.id, levelNumber: 2, minBetChips: 20_000, maxBetChips: -1 });
    expect((await me(alice!, t.id)).tournament).toMatchObject({ currentLevel: 2, levelMinChips: 20_000, handsPlayed: 2 });
    expect(errCode(await place(alice!, pick(t.tableId, 'rainbow', 10_000)))).toBe('coupon.min_stake');
    ok(await place(alice!, pick(t.tableId, 'rainbow', 20_000, 2)));
  });

  it('lets a short stack go all-in on one pick for one flop', async () => {
    const { t, dealer, players: [alice] } = await running(['alice'], { startingStack: 15_000 });
    // Level 1 minimum is 10,000: losing it leaves 5,000, below the minimum.
    ok(await place(alice!, pick(t.tableId, 'rainbow', 10_000)));
    await dealHand(dealer, t.tableId, PAIRED);
    expect(errCode(await place(alice!, pick(t.tableId, 'rainbow', 4_000)))).toBe('coupon.min_stake');
    const split = { tableId: t.tableId, rounds: 1, selections: [{ market: 'rainbow', stakeCents: 2_500 }, { market: 'has-ace', stakeCents: 2_500 }] };
    expect(errCode(await place(alice!, split))).toBe('coupon.min_stake');
    ok(await place(alice!, pick(t.tableId, 'rainbow', 5_000)));
    expect((await me(alice!, t.id)).registration).toMatchObject({ chips: 0, chipsInPlay: 5_000, status: 'active' });
  });
});

describe('busts, rebuys and add-ons', () => {
  it('busts a player at zero chips with no rebuy', async () => {
    const { t, dealer, players: [alice] } = await running(['alice', 'bob'], { startingStack: 10_000 });
    ok(await place(alice!, pick(t.tableId, 'rainbow', 10_000)));
    await dealHand(dealer, t.tableId, PAIRED);
    expect((await me(alice!, t.id)).registration).toMatchObject({ status: 'busted', eliminatedReason: 'chips', outAtHand: 1 });
    expect(env.events.named('tournament:player:busted').at(-1)!.payload).toMatchObject({ tournamentId: t.id, username: 'alice', reason: 'chips' });
    expect(errCode(await place(alice!, pick(t.tableId, 'rainbow', 10_000)))).toBe('coupon.not_active');
  });

  it('keeps a zero stack alive while a rebuy is available, within the limits', async () => {
    const { t, dealer, players: [alice] } = await running(['alice', 'bob'], { startingStack: 10_000, allowRebuys: true, maxRebuys: 1, rebuyEndHand: 2, rebuyStack: 10_000 });
    expect(errCode(await alice!.post(`/api/tournaments/${t.id}/rebuy`))).toBe('trm.rebuy_needs_zero');
    ok(await place(alice!, pick(t.tableId, 'rainbow', 10_000)));
    await dealHand(dealer, t.tableId, PAIRED);
    expect((await me(alice!, t.id)).registration).toMatchObject({ status: 'active', chips: 0, canRebuy: true });
    ok(await alice!.post(`/api/tournaments/${t.id}/rebuy`));
    ok(await place(alice!, pick(t.tableId, 'rainbow', 10_000)));
    await dealHand(dealer, t.tableId, PAIRED);
    expect(errCode(await alice!.post(`/api/tournaments/${t.id}/rebuy`))).toBe('trm.rebuy_period_ended');
    expect((await me(alice!, t.id)).registration).toMatchObject({ status: 'busted', rebuys: 1 });
  });

  it('opens the add-on for one break after the rebuy period', async () => {
    const { t, dealer, players: [alice] } = await running(['alice'], { allowRebuys: true, rebuyEndHand: 1, allowAddons: true, addonEndHand: 2, addonStack: 500_000 });
    expect(errCode(await alice!.post(`/api/tournaments/${t.id}/addon`))).toBe('trm.addon_not_started');
    await dealHand(dealer, t.tableId, RAINBOW);
    expect(ok(await alice!.post(`/api/tournaments/${t.id}/addon`))).toEqual({ chips: 1_500_000 });
    expect(errCode(await alice!.post(`/api/tournaments/${t.id}/addon`))).toBe('trm.addon_already_taken');
    expect(await balance(alice!)).toBe(10_000 - 550 - 500);
  });

  it('closes the add-on after its window', async () => {
    const { t, dealer, players: [alice, bob] } = await running(['alice', 'bob'], { allowAddons: true, rebuyEndHand: 1, addonEndHand: 1 });
    await dealHand(dealer, t.tableId, RAINBOW);
    expect(errCode(await alice!.post(`/api/tournaments/${t.id}/addon`))).toBe('trm.addon_ended');
    expect(errCode(await bob!.post(`/api/tournaments/${t.id}/rebuy`))).toBe('trm.rebuys_not_allowed');
  });

  it('refuses add-ons when they are off or the caller is not entered', async () => {
    const { t, owner, players: [alice] } = await running(['alice']);
    expect(errCode(await alice!.post(`/api/tournaments/${t.id}/addon`))).toBe('trm.addons_not_allowed');
    expect(errCode(await owner.post(`/api/tournaments/${t.id}/addon`))).toBe('trm.not_registered');
  });
});

describe('participation', () => {
  it('eliminates a player who can no longer reach the minimum, keeping their stack', async () => {
    // 50% of 4 hands: 2 hands with action needed.
    const { t, dealer, players: [alice, bob] } = await running(['alice', 'bob'], { minActionPct: 50 });
    const play = async () => { ok(await place(alice!, pick(t.tableId, 'rainbow', 10_000))); };
    await dealHand(dealer, t.tableId, RAINBOW, play);
    await dealHand(dealer, t.tableId, RAINBOW, play);
    expect((await me(bob!, t.id)).myParticipation).toMatchObject({ required: 2, done: 0, remaining: 2, spare: 0, status: 'last_chance' });
    await dealHand(dealer, t.tableId, RAINBOW);
    const bobView = await me(bob!, t.id);
    expect(bobView.registration).toMatchObject({ status: 'eliminated', eliminatedReason: 'participation', chips: 1_000_000, outAtHand: 3 });
    expect((await me(alice!, t.id)).myParticipation).toMatchObject({ done: 2, dealt: 3, status: 'good' });
    const standings = bobView.standings.map((s: { username: string; position: number }) => [s.username, s.position]);
    expect(standings).toEqual([['alice', 1], ['bob', 2]]);
  });
});

describe('finish and prizes', () => {
  it('ends after the last hand and pays the progressive pool by chips', async () => {
    const { t, clubId, owner, dealer, players: [alice, bob, carol] } = await running(['alice', 'bob', 'carol']);
    await dealHand(dealer, t.tableId, RAINBOW, async () => {
      ok(await place(alice!, pick(t.tableId, 'rainbow', 10_000)));
      ok(await place(bob!, pick(t.tableId, 'any-pair', 10_000)));
    });
    for (let i = 0; i < 3; i += 1) await dealHand(dealer, t.tableId, RAINBOW);
    const detail = await me(alice!, t.id);
    expect(detail.tournament).toMatchObject({ status: 'finished', poolCents: 1_500 });
    expect(detail.standings.map((s: { username: string; prizeCents: number }) => [s.username, s.prizeCents]))
      .toEqual([['alice', 750], ['carol', 450], ['bob', 300]]);
    expect(await balance(alice!)).toBe(10_000 - 550 + 750);
    expect(await balance(bob!)).toBe(10_000 - 550 + 300);
    expect(await balance(carol!)).toBe(10_000 - 550 + 450);
    expect(ok(await owner.get(`/api/clubs/${clubId}/points`))).toMatchObject({ inTournaments: 0, riding: 0, drift: 0 });
    expect(env.events.named('tournament:finished')).not.toHaveLength(0);
    expect(errCode(await dealer.post(`/api/dealer/table/${t.tableId}/start-hand`))).toBe('dealer.not_dealing');
  });

  it('covers a guarantee from the club pool and returns unfilled places', async () => {
    const { t, clubId, owner, players: [alice, bob] } = await running(['alice', 'bob'], { prizePoolType: 'guaranteed', guaranteedPrizeCents: 5_000 });
    const before = ok(await owner.get(`/api/clubs/${clubId}/points`)).pool as number;
    const monitor = ok(await owner.get(`/api/tournaments/${t.id}/monitor`));
    expect(monitor.kpis).toMatchObject({ entrants: 2, inPlay: 2, poolCents: 5_000, collectedCents: 1_000, reservedCents: 4_000 });
    const res = ok(await owner.post(`/api/tournaments/${t.id}/finish`));
    expect(res.poolCents).toBe(5_000);
    // Equal stacks at the finish share 1st and 2nd: (2,500 + 1,500) / 2 each; 3rd has no player.
    expect(res.standings.map((s: { position: number; prizeCents: number }) => [s.position, s.prizeCents])).toEqual([[1, 2_000], [1, 2_000]]);
    expect(await balance(alice!)).toBe(10_000 - 550 + 2_000);
    expect(await balance(bob!)).toBe(10_000 - 550 + 2_000);
    const after = ok(await owner.get(`/api/clubs/${clubId}/points`));
    expect(after).toMatchObject({ inTournaments: 0, drift: 0 });
    // The club covered 4,000 of the guarantee and got the unpaid 3rd share (1,000) back.
    expect(after.pool - before).toBe(-3_000);
  });

  it('voids live coupons back to the stacks when finished by staff mid-hand', async () => {
    const { t, owner, dealer, players: [alice] } = await running(['alice']);
    ok(await dealer.post(`/api/dealer/table/${t.tableId}/start-hand`));
    ok(await place(alice!, pick(t.tableId, 'rainbow', 10_000, 2)));
    ok(await owner.post(`/api/tournaments/${t.id}/finish`));
    expect((await me(alice!, t.id)).registration).toMatchObject({ chips: 1_000_000, chipsInPlay: 0, finishPosition: 1, prizeCents: 250 });
    expect(env.events.named('coupon:voided').at(-1)!.payload).toMatchObject({ refundCents: 20_000, roundsUnresolved: 2, unit: 'chips' });
    expect(env.events.named('hand:cancelled')).not.toHaveLength(0);
  });

  it('reports chips played, players, hits and markets; logs every step', async () => {
    const { t, owner, dealer, players: [alice] } = await running(['alice']);
    await dealHand(dealer, t.tableId, RAINBOW, async () => { ok(await place(alice!, pick(t.tableId, 'rainbow', 10_000))); });
    ok(await owner.post(`/api/tournaments/${t.id}/finish`));
    const report = ok(await owner.get(`/api/tournaments/${t.id}/report`));
    expect(report).toMatchObject({ chipsPlayed: 10_000, chipsPaid: 23_000, chipsKept: -13_000, poolCents: 500 });
    expect(report.players[0]).toMatchObject({ username: 'alice', picks: 1, avgStakeCents: 10_000, netCents: 13_000 });
    expect(report.biggestHits[0]).toMatchObject({ market: 'rainbow', stakeCents: 10_000, netCents: 13_000 });
    expect(report.byMarket[0]).toMatchObject({ market: 'rainbow', picks: 1, won: 1, playedCents: 10_000, keptCents: -13_000 });
    expect(report.byMarket[0].expectedKeptCents).toBe(Math.round(10_000 * (1 - (8_788 / 22_100) * 2.3)));
    const { events } = ok(await owner.get(`/api/tournaments/${t.id}/logs`));
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['created', 'registered', 'started', 'finished']));
    expect(errCode(await alice!.get(`/api/tournaments/${t.id}/report`))).toBe('club.capability_missing');
  });
});
