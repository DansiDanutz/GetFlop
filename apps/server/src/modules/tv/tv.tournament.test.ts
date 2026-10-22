import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hands } from '../../db/schema/index.js';
import { setupClub } from '../../test/fixtures.js';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { resetTournamentTvSource, setTournamentTvSource, type TournamentTvSource } from './tournamentSource.js';
import { tv } from './tv.fixtures.js';

let env: TestEnv;
let clubId: string;
let owner: Agent;
let alice: Agent;
let tableId: string;

function fakeSource(status = 'running'): TournamentTvSource {
  return {
    async find(_db, id) {
      return id === 'trm-1' ? { id, clubId, name: 'Friday Freeze', status, tableId } : null;
    },
    async board() {
      return {
        totalHands: 30,
        endCondition: 'hands',
        levels: [
          { levelNumber: 1, minBetChips: 10_000, maxBetChips: -1, endHand: 10 },
          { levelNumber: 2, minBetChips: 20_000, maxBetChips: -1, endHand: 20 },
          { levelNumber: 3, minBetChips: 40_000, maxBetChips: -1, endHand: 30 },
        ],
        prizePoolCents: 150_000,
        guaranteed: true,
        payouts: [{ place: 1, amountCents: 100_000 }, { place: 2, amountCents: 50_000 }],
        entrants: 3,
        entries: [
          { name: 'Alice', chips: 1_200_000, status: 'playing', place: null, payoutCents: 0 },
          { name: 'Bob', chips: 0, status: 'finished', place: 3, payoutCents: 0 },
          { name: 'Cleo', chips: 1_800_000, status: 'playing', place: null, payoutCents: 0 },
        ],
      };
    },
  };
}

beforeEach(async () => {
  env = await createTestEnv();
  const club = await setupClub(env, { players: ['alice'], pointsEach: 0 });
  clubId = club.clubId;
  owner = club.owner;
  alice = club.players[0]!;
  const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'Final Table' }));
  tableId = table.id;
});
afterEach(async () => {
  resetTournamentTvSource();
  await env.close();
});

async function pairTournament(): Promise<string> {
  const { pairingCode } = ok(await owner.post('/api/tv/tournament-pairings').send({ tournamentId: 'trm-1' }));
  const claim = ok(await tv(env).post('/api/tv/tournament-pairings/claim').send({ code: pairingCode }));
  expect(claim.tournamentName).toBe('Friday Freeze');
  return claim.displayToken as string;
}

describe('Tournament TV', () => {
  it('degrades to tournament.not_found when the tournament is unknown', async () => {
    const res = await owner.post('/api/tv/tournament-pairings').send({ tournamentId: 'missing' });
    expect(errCode(res)).toBe('tournament.not_found');
    expect(errCode(await owner.post('/api/tv/tournament-sessions').send({ tournamentId: 'missing' }))).toBe('tournament.not_found');
  });

  it('only staff create tournament codes', async () => {
    setTournamentTvSource(fakeSource());
    expect(errCode(await alice.post('/api/tv/tournament-pairings').send({ tournamentId: 'trm-1' }))).toBe('club.capability_missing');
  });

  it('shows hand, level, prize pool, players left and the leaderboard with names and chips', async () => {
    setTournamentTvSource(fakeSource());
    const token = await pairTournament();
    await env.db.insert(hands).values({
      clubId, tableId, tournamentId: 'trm-1', handNumber: 12, status: 'settled', card1: 'Ah', card2: 'Kd', card3: '2c',
      matchingSlugs: ['has-ace', 'rainbow'], createdAt: env.clock.now(),
    });
    const data = ok(await tv(env).get(`/api/tv/tournament/${token}`));
    expect(data.tournament).toMatchObject({ name: 'Friday Freeze', status: 'running', totalHands: 30, endCondition: 'hands' });
    expect(data.currentHand).toMatchObject({ handNumber: 12, status: 'settled', cards: ['Ah', 'Kd', '2c'] });
    expect(data.level).toMatchObject({
      current: { levelNumber: 2, minBetChips: 20_000, maxBetChips: -1, startHand: 11, endHand: 20 },
      next: { levelNumber: 3, startHand: 21 }, isFinal: false,
    });
    expect(data).toMatchObject({ prizePoolCents: 150_000, guaranteed: true, playersLeft: 2, entrants: 3 });
    expect(data.payouts).toEqual([{ place: 1, amountCents: 100_000 }, { place: 2, amountCents: 50_000 }]);
    expect(data.leaderboard.map((r: { name: string; chips: number; rank: number }) => [r.rank, r.name, r.chips]))
      .toEqual([[1, 'Cleo', 1_800_000], [2, 'Alice', 1_200_000], [3, 'Bob', 0]]);
    expect(data.more).toBe(0);
  });

  it('works before the first hand and when the source cannot build a board', async () => {
    setTournamentTvSource({ ...fakeSource('upcoming'), board: async () => { throw new Error('table missing'); } });
    const token = await pairTournament();
    const data = ok(await tv(env).get(`/api/tv/tournament/${token}`));
    expect(data.currentHand).toBeNull();
    expect(data.leaderboard).toEqual([]);
    expect(data.level).toEqual({ current: null, next: null, isFinal: false });
  });

  it('direct links and expiry work for tournaments too', async () => {
    setTournamentTvSource(fakeSource('finished'));
    const { token } = ok(await owner.post('/api/tv/tournament-sessions').send({ tournamentId: 'trm-1' }));
    expect(ok(await tv(env).get(`/api/tv/tournament/${token}`)).tournament.status).toBe('finished');
    expect((await tv(env).get(`/api/tv/cash/${token}`)).status).toBe(410);
    env.clock.advance(24 * 3_600_000 + 1);
    expect((await tv(env).get(`/api/tv/tournament/${token}`)).status).toBe(410);
  });

  it('a tournament of another club is a club mismatch', async () => {
    setTournamentTvSource(fakeSource());
    const other = await setupClub(env, { owner: 'owner2', clubName: 'Other', players: [] });
    const res = await other.owner.post('/api/tv/tournament-pairings').set('X-Club-Id', other.clubId).send({ tournamentId: 'trm-1' });
    expect(errCode(res)).toBe('tv.club_mismatch');
  });
});
