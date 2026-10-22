import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { closeWeeks } from './board.js';
import { arenaWorld, dealWith, picks, STAR } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

const RAINBOW: [string, string, string] = ['2h', '7d', 'Jc'];
const badgesOf = async (a: Agent) => (ok(await a.get('/api/arena/medals')).badges as { code: string; earned: boolean; times: number; progress: unknown }[]);
const earned = async (a: Agent) => (await badgesOf(a)).filter((b) => b.earned).map((b) => b.code);

async function playWeek() {
  const world = await arenaWorld(env, ['alice', 'bob', 'carol', 'dave']);
  const [alice, bob, carol] = world.players;
  const { tableId } = world.ids;
  ok(await alice!.post('/api/arena/coupon').send(picks(tableId, ['rainbow'], 100 * STAR)));
  ok(await bob!.post('/api/arena/coupon').send(picks(tableId, ['any-pair'], 100 * STAR)));
  ok(await carol!.post('/api/arena/coupon').send(picks(tableId, ['rainbow'], 50 * STAR, 2)));
  await dealWith(env, world.ids, RAINBOW);
  await dealWith(env, world.ids, RAINBOW);
  return world;
}

describe('the weekly board', () => {
  it('ranks by net Stars, then by flops played, with the biggest hit', async () => {
    const { players: [alice, , carol, dave] } = await playWeek();
    const view = ok(await alice!.get('/api/arena/board?period=week'));
    expect(view.top.map((r: { username: string; netCents: number; flops: number }) => [r.username, r.netCents, r.flops])).toEqual([
      ['carol', 130 * STAR, 2], ['alice', 130 * STAR, 1], ['bob', -100 * STAR, 1],
    ]);
    expect(view.podium).toHaveLength(3);
    expect(view.me).toMatchObject({ rank: 2, me: true });
    expect(view.biggestHit).toMatchObject({ username: 'alice', multiplier: 2.3, starsCents: 230 * STAR });
    expect(view.closesAt).toBe('2026-09-27T21:00:00.000Z');
    expect(ok(await carol!.get('/api/arena/bar'))).toMatchObject({ rank: 1, weekOf: '2026-09-21', balanceCents: 2_130 * STAR });
    expect(ok(await dave!.get('/api/arena/board?period=all'))).toMatchObject({ me: null, hasPlayed: false, players: 3 });
    expect(ok(await dave!.get('/api/arena/board?period=month')).top).toHaveLength(3);
  });

  it('lets a player hide their name and keep their place', async () => {
    const { players: [alice, bob, , dave] } = await playWeek();
    expect(errCode(await dave!.post('/api/arena/board-visibility').send({ hidden: true }))).toBe('arena.not_played');
    expect(ok(await bob!.post('/api/arena/board-visibility').send({ hidden: true }))).toEqual({ hidden: true });
    const seenByAlice = ok(await alice!.get('/api/arena/board')).top[2];
    expect(seenByAlice).toMatchObject({ rank: 3, username: null, hidden: true, netCents: -100 * STAR });
    const seenByBob = ok(await bob!.get('/api/arena/board'));
    expect(seenByBob).toMatchObject({ meHidden: true, me: { rank: 3, username: 'bob', hidden: true } });
    ok(await bob!.post('/api/arena/board-visibility').send({ hidden: false }));
    expect(ok(await alice!.get('/api/arena/board')).top[2].username).toBe('bob');
  });

  it('closes the week on Monday with the weekly badges and the champion title', async () => {
    const { players: [alice, bob, carol] } = await playWeek();
    // The first run closes the (empty) week before; nothing more until Monday.
    expect(await closeWeeks(env.ctx)).toBe('2026-09-14');
    expect(await closeWeeks(env.ctx)).toBeNull();
    env.clock.advance(5 * 86_400_000);
    expect(await closeWeeks(env.ctx)).toBe('2026-09-21');
    expect(await closeWeeks(env.ctx)).toBeNull();
    expect(await earned(carol!)).toEqual(expect.arrayContaining(['week_top10', 'week_top3', 'week_first']));
    expect(await earned(bob!)).toEqual(expect.arrayContaining(['week_top10', 'week_top3']));
    expect(await earned(bob!)).not.toContain('week_first');
    const all = ok(await alice!.get('/api/arena/board?period=all')).top;
    expect(all[0]).toMatchObject({ username: 'carol', titles: ['champion'] });
    expect(ok(await alice!.get('/api/arena/board?period=week')).top).toEqual([]);
    expect(env.events.named('arena:badges').at(-1)!.payload).toMatchObject({ week: '2026-09-21' });
  });
});

describe('badges', () => {
  it('awards the first flop and pushes arena:badges after the settlement', async () => {
    const { players: [alice, , carol] } = await playWeek();
    expect(await earned(alice!)).toEqual(['first_flop']);
    const pushes = env.events.named('arena:badges').filter((e) => e.room === `user:${carol!.userId}`);
    expect(pushes.map((e) => e.payload)).toEqual([{ badges: ['first_flop'] }]);
    const flops10 = (await badgesOf(carol!)).find((b) => b.code === 'flops_10');
    expect(flops10).toMatchObject({ earned: false, progress: { current: 2, target: 10 } });
  });

  it('awards the long shot, a big one and the comeback in one week', async () => {
    const { ids, players: [alice] } = await arenaWorld(env);
    ok(await alice!.post('/api/arena/coupon').send(picks(ids.tableId, ['any-pair'], 1_950 * STAR)));
    await dealWith(env, ids, ['Ah', 'Kd', 'Qc']);
    ok(await alice!.post('/api/arena/coupon').send(picks(ids.tableId, ['trips-or-sf'], 50 * STAR)));
    await dealWith(env, ids, ['Ah', 'Ad', 'Ac']);
    expect(ok(await alice!.get('/api/arena/summary')).balanceCents).toBe(8_500 * STAR);
    expect(await earned(alice!)).toEqual(expect.arrayContaining(['first_flop', 'hit_x170', 'hit_x40', 'comeback']));
  });

  it('awards three in a row and shows streak progress', async () => {
    const { ids, players: [alice] } = await arenaWorld(env);
    ok(await alice!.post('/api/arena/coupon').send(picks(ids.tableId, ['rainbow'], 10 * STAR, 4)));
    await dealWith(env, ids, RAINBOW);
    await dealWith(env, ids, RAINBOW);
    const two = (await badgesOf(alice!)).find((b) => b.code === 'three_in_a_row');
    expect(two).toMatchObject({ earned: false, progress: { current: 2, target: 3, best: 2 } });
    await dealWith(env, ids, RAINBOW);
    expect(await earned(alice!)).toContain('three_in_a_row');
    await dealWith(env, ids, ['2h', '2d', 'Jh']);
    const after = (await badgesOf(alice!)).find((b) => b.code === 'three_in_a_row');
    expect(after).toMatchObject({ earned: true, progress: { current: 0, best: 3 } });
  });
});
