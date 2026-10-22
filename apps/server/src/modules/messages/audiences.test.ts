import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grantRole, setupClub, type ClubFixture } from '../../test/fixtures.js';
import { createTestEnv, ok, type TestEnv } from '../../test/harness.js';
import { registerTournamentSource } from './targets.js';
import { scoped, seedCoupon, seedTable, setJoinedAt } from './test-helpers.js';

let env: TestEnv;
let club: ClubFixture;
const DAY = 86_400_000;
const NAMES = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];

beforeEach(async () => {
  env = await createTestEnv();
  club = await setupClub(env, { players: NAMES, pointsEach: 0 });
});
afterEach(async () => {
  registerTournamentSource(null);
  await env.close();
});

const player = (i: number) => club.players[i]!;
const daysAgo = (d: number) => new Date(env.clock.now().getTime() - d * DAY);

async function audiences(tz?: string): Promise<Record<string, { count: number; total: number; muted: number; capped: number }>> {
  const { audiences: list } = ok(await scoped(club.owner, club.clubId).get(`/messages/audiences${tz ? `?tz=${encodeURIComponent(tz)}` : ''}`));
  return Object.fromEntries(list.map((a: { key: string }) => [a.key, a]));
}

describe('audiences', () => {
  it('counts each group from membership and play history', async () => {
    // Clock: 2026-09-24 18:00 UTC. Everyone joined 60 days ago except p7 (5 days ago).
    for (const p of club.players) await setJoinedAt(env, club.clubId, p.userId, daysAgo(60));
    await setJoinedAt(env, club.clubId, player(6).userId, daysAgo(5));
    const ring = await seedTable(env, club.clubId, { name: 'Ring' });
    const trnTable = await seedTable(env, club.clubId, { name: 'T', tournamentId: 'trn-1' });
    await seedCoupon(env, club.clubId, ring, player(0).userId, { at: daysAgo(1) });
    await seedCoupon(env, club.clubId, ring, player(0).userId, { at: daysAgo(2) });
    await seedCoupon(env, club.clubId, ring, player(1).userId, { at: daysAgo(10) });
    await seedCoupon(env, club.clubId, trnTable, player(2).userId, { at: daysAgo(3), tournamentId: 'trn-1' });
    await seedCoupon(env, club.clubId, ring, player(3).userId, { at: daysAgo(40) });
    await grantRole(env, club.clubId, player(4).userId, 'dealer');

    const a = await audiences();
    expect(a.all).toMatchObject({ count: 7, total: 7 });
    expect(a.active_7!.total).toBe(2); // p1 ring, p3 tournament
    expect(a.active_30!.total).toBe(3); // + p2
    expect(a.inactive_30!.total).toBe(3); // p4 (last play 40 days ago), p5, p6; not p7 (new)
    expect(a.new_14!.total).toBe(1);
    expect(a.ring_month!.total).toBe(2); // since 1 Sep: p1, p2
    expect(a.tourney_month!.total).toBe(1);
    expect(a.staff!.total).toBe(1);
    expect(a.top_active!.total).toBe(3); // the minimum of 5 covers all 3 who played
    expect(a.member).toMatchObject({ count: 7 });
  });

  it('keeps the top 10% by activity when many members play', async () => {
    const ring = await seedTable(env, club.clubId, { name: 'Ring' });
    for (const [i, p] of club.players.entries()) {
      for (let n = 0; n <= i; n++) await seedCoupon(env, club.clubId, ring, p.userId, { at: daysAgo(1) });
    }
    const a = await audiences();
    expect(a.top_active!.total).toBe(5);
    ok(await scoped(club.owner, club.clubId).post('/messages', { audience: 'top_active', body: 'Thanks, regulars' }));
    // The least active two did not get it.
    expect(ok(await scoped(player(0), club.clubId).get('/messages')).messages).toHaveLength(0);
    expect(ok(await scoped(player(1), club.clubId).get('/messages')).messages).toHaveLength(0);
    expect(ok(await scoped(player(6), club.clubId).get('/messages')).messages).toHaveLength(1);
  });

  it('counts "this month" in the writer timezone', async () => {
    // 2026-09-30 22:30 UTC is already 1 Oct in Athens (UTC+3).
    env.clock.advance(6 * DAY + 4.5 * 3_600_000);
    const ring = await seedTable(env, club.clubId, { name: 'Ring' });
    await seedCoupon(env, club.clubId, ring, player(0).userId, { at: new Date('2026-09-30T20:00:00Z') });
    expect((await audiences('UTC')).ring_month!.total).toBe(1);
    expect((await audiences('Europe/Athens')).ring_month!.total).toBe(0);
  });

  it('adds tournament entrants reported by the tournament module', async () => {
    registerTournamentSource({
      targets: async () => [{ id: 'trn-9', name: 'Friday Freeroll', startsAt: '2026-09-25T19:00:00.000Z', status: 'upcoming' }],
      entrants: async () => [player(5).userId],
      registeredSince: async () => [],
    });
    const a = await audiences();
    expect(a.tourney_month!.total).toBe(1);
    expect(a.active_7!.total).toBe(1);
    const targets = ok(await scoped(club.owner, club.clubId).get('/messages/targets'));
    expect(targets.tournaments).toHaveLength(1);
    const res = ok(await scoped(club.owner, club.clubId).post('/messages', {
      audience: 'tourney_month', body: 'Register now', action: { type: 'tournament', ref: 'trn-9' },
    }));
    expect(res.recipientCount).toBe(1);
  });
});
