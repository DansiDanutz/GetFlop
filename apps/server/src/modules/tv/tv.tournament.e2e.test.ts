import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, ok, type TestEnv } from '../../test/harness.js';
import { create, dealHand, pick, RAINBOW, shortEvent, tournamentWorld } from '../tournaments/testkit.js';
import { tv } from './tv.fixtures.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv({ bettingTimerSeconds: 0 }); });
afterEach(async () => { await env.close(); });

describe('Tournament TV on a real tournament (default source)', () => {
  it('follows hands, levels, the prize pool and the leaderboard through to the final results', async () => {
    const { owner, dealer, players: [alice, bob] } = await tournamentWorld(env, ['alice', 'bob']);
    const t = await create(owner, shortEvent(dealer.userId));
    for (const p of [alice!, bob!]) ok(await p.post(`/api/tournaments/${t.id}/register`));

    const { pairingCode } = ok(await owner.post('/api/tv/tournament-pairings').send({ tournamentId: t.id }));
    const claim = ok(await tv(env).post('/api/tv/tournament-pairings/claim').send({ code: pairingCode }));
    expect(claim.tournamentName).toBe('Short Event');
    const read = async () => ok(await tv(env).get(`/api/tv/tournament/${claim.displayToken}`));

    const before = await read();
    expect(before).toMatchObject({ tournament: { status: 'upcoming', totalHands: 4 }, currentHand: null, entrants: 2, playersLeft: 2 });
    expect(before.level.current).toMatchObject({ levelNumber: 1, startHand: 1, endHand: 2 });

    ok(await owner.post(`/api/tournaments/${t.id}/start`));
    ok(await alice!.post('/api/player/coupon').send(pick(t.tableId, 'rainbow', 10_000)));
    await dealHand(dealer, t.tableId, RAINBOW);

    const live = await read();
    expect(live.tournament.status).toBe('active');
    expect(live.currentHand).toMatchObject({ handNumber: 1, status: 'settled', cards: ['Qc', '7h', '3s'] });
    expect(live.level).toMatchObject({ current: { levelNumber: 1 }, next: { levelNumber: 2, startHand: 3 }, isFinal: false });
    expect(live.prizePoolCents).toBeGreaterThan(0);
    expect(live.payouts.reduce((s: number, p: { amountCents: number }) => s + p.amountCents, 0)).toBe(live.prizePoolCents);
    expect(live.leaderboard.map((r: { name: string; chips: number; status: string }) => [r.name, r.chips, r.status]))
      .toEqual([['alice', 1_013_000, 'playing'], ['bob', 1_000_000, 'playing']]);
    expect(JSON.stringify(live)).not.toContain(alice!.userId);

    ok(await owner.post(`/api/tournaments/${t.id}/finish`));
    const final = await read();
    expect(final.tournament.status).toBe('finished');
    expect(final.playersLeft).toBe(0);
    expect(final.leaderboard[0]).toMatchObject({ name: 'alice', rank: 1, status: 'finished' });
    expect(final.leaderboard[0].payoutCents).toBeGreaterThan(0);
  });
});
