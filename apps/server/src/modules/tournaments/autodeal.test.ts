import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { runTournamentJobs } from './autodeal.js';
import { DEFAULT_BOT_COUNT } from './bots.js';
import { balance, create, shortEvent, tournamentWorld, wizardBody } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

const LEVELS = [
  { levelNumber: 1, minBetChips: 10_000, maxBetChips: -1, endHand: 2 },
  { levelNumber: 2, minBetChips: 20_000, maxBetChips: -1, endHand: 3 },
];
/** Always plays, always the first market on the menu. */
const rng = () => 0.1;

describe('auto-deal', () => {
  it('deals every n seconds, lets the bots play and stops when the tournament ends', async () => {
    const { clubId, owner, players: [alice] } = await tournamentWorld(env, ['alice']);
    const t = await create(owner, wizardBody({
      autoDealSeconds: 10, botsAllowed: true, endValue: 3, levels: LEVELS, minActionPct: 0, allowLateRegistration: false,
      allowedBetTypeIds: ['rainbow', 'any-pair'],
    }));
    ok(await alice!.post(`/api/tournaments/${t.id}/register`));
    ok(await owner.post(`/api/tournaments/${t.id}/start`));
    expect(ok(await owner.get(`/api/tournaments/${t.id}/monitor`)).kpis.entrants).toBe(1 + DEFAULT_BOT_COUNT);

    expect(await runTournamentJobs(env.ctx, rng)).toBe(1);
    const live = ok(await owner.get(`/api/tournaments/${t.id}/monitor`));
    expect(live.liveHand).toMatchObject({ status: 'betting_open' });
    expect(live.autoDeal).toEqual({ on: true, intervalSeconds: 10 });
    const bots = live.standings.filter((s: { isBot: boolean }) => s.isBot);
    expect(bots).toHaveLength(DEFAULT_BOT_COUNT);
    expect(bots.every((b: { chipsInPlay: number }) => b.chipsInPlay === 10_000)).toBe(true);
    expect(env.events.named('hand:started')).toHaveLength(1);

    env.clock.advance(7_000);
    expect(await runTournamentJobs(env.ctx, rng)).toBe(0);
    env.clock.advance(1_000); // 10 s interval − 2 s to show the flop
    expect(await runTournamentJobs(env.ctx, rng)).toBe(1);
    expect(env.events.named('hand:settled')).toHaveLength(1);

    for (let i = 0; i < 40 && ok(await owner.get(`/api/tournaments/${t.id}`)).tournament.status === 'active'; i += 1) {
      env.clock.advance(1_000);
      await runTournamentJobs(env.ctx, rng);
    }
    const done = ok(await owner.get(`/api/tournaments/${t.id}`));
    expect(done.tournament).toMatchObject({ status: 'finished', handsPlayed: 3 });
    expect(done.standings.filter((s: { isBot: boolean; prizeCents: number }) => s.isBot && s.prizeCents > 0)).toEqual([]);
    const aliceLine = done.standings.find((s: { username: string }) => s.username === 'alice');
    expect(await balance(alice!)).toBe(10_000 - 550 + aliceLine.prizeCents);
    expect(ok(await owner.get(`/api/clubs/${clubId}/points`))).toMatchObject({ inTournaments: 0, riding: 0, drift: 0 });

    env.clock.advance(60_000);
    expect(await runTournamentJobs(env.ctx, rng)).toBe(0);
    const { events } = ok(await owner.get(`/api/tournaments/${t.id}/logs`));
    expect(events[0].kind).toBe('finished');
    expect(events.map((e: { kind: string }) => e.kind)).toContain('bots_entered');
  });

  it('switches a dealer event to auto-deal and back', async () => {
    const { owner, dealer, players: [alice, bob] } = await tournamentWorld(env, ['alice', 'bob']);
    const t = await create(owner, shortEvent(dealer.userId));
    ok(await alice!.post(`/api/tournaments/${t.id}/register`));
    ok(await bob!.post(`/api/tournaments/${t.id}/register`));
    ok(await owner.post(`/api/tournaments/${t.id}/start`));
    expect(errCode(await owner.post(`/api/tournaments/${t.id}/auto-deal`).send({ intervalSeconds: 4 }))).toBe('validation.invalid');
    expect(ok(await owner.post(`/api/tournaments/${t.id}/auto-deal`).send({ intervalSeconds: 5 }))).toEqual({ autoDeal: true, intervalSeconds: 5 });
    expect(errCode(await dealer.post(`/api/dealer/table/${t.tableId}/start-hand`))).toBe('dealer.not_dealing');
    expect(await runTournamentJobs(env.ctx, rng)).toBe(1);
    expect(ok(await owner.del(`/api/tournaments/${t.id}/auto-deal`))).toEqual({ autoDeal: false });
    expect(env.events.named('hand:settled')).toHaveLength(1);
    env.clock.advance(60_000);
    expect(await runTournamentJobs(env.ctx, rng)).toBe(0);
    expect(ok(await owner.get(`/api/tournaments/${t.id}/monitor`))).toMatchObject({ hand: 1, liveHand: null, autoDeal: { on: false } });
  });
});

describe('automatic start', () => {
  it('starts at the scheduled time and logs a start it could not make', async () => {
    const { owner, players: [alice] } = await tournamentWorld(env, ['alice']);
    const at = new Date(env.clock.now().getTime() + 60_000).toISOString();
    const first = await create(owner, wizardBody({ name: 'Auto one', autoStart: true, scheduledAt: at }));
    const second = await create(owner, wizardBody({ name: 'Auto two', autoStart: true, scheduledAt: at }));
    ok(await alice!.post(`/api/tournaments/${first.id}/register`));
    await runTournamentJobs(env.ctx, rng);
    expect(ok(await alice!.get(`/api/tournaments/${first.id}`)).tournament.status).toBe('upcoming');
    env.clock.advance(61_000);
    await runTournamentJobs(env.ctx, rng);
    const [s1, s2] = await Promise.all([first, second].map(async (x) => ok(await owner.get(`/api/tournaments/${x.id}`)).tournament.status));
    // Club 100 runs one tournament at a time: one starts, the other waits and logs why.
    expect([s1, s2].sort()).toEqual(['active', 'upcoming']);
    const blocked = s1 === 'upcoming' ? first : second;
    const { events } = ok(await owner.get(`/api/tournaments/${blocked.id}/logs`));
    expect(events[0]).toMatchObject({ kind: 'auto_start_failed', severity: 'warning', data: { code: 'commerce.capacity_tournaments_staff' } });
  });
});
