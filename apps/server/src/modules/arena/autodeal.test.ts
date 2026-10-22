import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hands } from '../../db/schema/index.js';
import { createTestEnv, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { closeExpiredBetting } from '../game/hands.js';
import { purgeOldArenaHands, runArenaDeal } from './autodeal.js';
import { flopCounter } from './stats.js';
import { arenaWorld, dealWith, picks, STAR } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

const clock = async (agent: Agent, tableId: string) => {
  const { tables } = ok(await agent.get('/api/arena/tables'));
  return tables.find((t: { id: string }) => t.id === tableId).dealClock as { phase: string; remainingMs: number; windowMs: number };
};

describe('the auto-deal cycle', () => {
  it('sleeps while nobody sits, then deals open → close → flop → result → next hand', async () => {
    const { ids, players: [alice] } = await arenaWorld(env);
    expect(await runArenaDeal(env.ctx)).toEqual([null]);
    expect(await clock(alice!, ids.tableId)).toMatchObject({ phase: 'asleep' });

    // Sitting wakes the table: a hand starts at once with a 20 s picks window.
    const sat = ok(await alice!.post(`/api/arena/table/${ids.tableId}/sit`).send({}));
    expect(sat.table).toMatchObject({ awake: true, currentHand: { handNumber: 1, status: 'betting_open' }, dealSeconds: 30 });
    expect(sat.table.dealClock).toMatchObject({ phase: 'open', windowMs: 20_000, remainingMs: 20_000 });
    expect(sat).toMatchObject({ balanceCents: 2_000 * STAR, canPlay: true });
    ok(await alice!.post('/api/arena/coupon').send(picks(ids.tableId, ['rainbow'], 50 * STAR)));

    env.clock.advance(10_000);
    expect(await runArenaDeal(env.ctx)).toEqual([null]);
    env.clock.advance(10_000);
    expect(await runArenaDeal(env.ctx)).toEqual(['close']);
    expect(await clock(alice!, ids.tableId)).toMatchObject({ phase: 'closing', remainingMs: 3_000 });
    env.clock.advance(3_000);
    expect(await runArenaDeal(env.ctx)).toEqual(['flop']);
    expect(env.events.named('hand:settled')).toHaveLength(1);
    expect(await clock(alice!, ids.tableId)).toMatchObject({ phase: 'result', remainingMs: 7_000 });
    env.clock.advance(7_000);
    expect(await runArenaDeal(env.ctx)).toEqual(['start']);
    expect(env.events.named('hand:started').map((e) => (e.payload as { handNumber: number }).handNumber)).toEqual([1, 2]);
    expect(await flopCounter(env.db)).toBe(1);
  });

  it('agrees with the generic countdown job and resumes from the database after a pause', async () => {
    const { ids, players: [alice] } = await arenaWorld(env);
    ok(await alice!.post(`/api/arena/table/${ids.tableId}/sit`).send({}));
    // The server was down for 5 minutes mid-hand; the generic countdown closes picks first.
    env.clock.advance(300_000);
    expect(await closeExpiredBetting(env.ctx)).toBe(1);
    expect(await runArenaDeal(env.ctx)).toEqual([null]);
    env.clock.advance(3_000);
    expect(await runArenaDeal(env.ctx)).toEqual(['flop']);
    // Nobody seen for 5 minutes and no live coupon: the table goes back to sleep.
    expect(await runArenaDeal(env.ctx)).toEqual([null]);
    expect(await clock(alice!, ids.tableId)).toMatchObject({ phase: 'asleep' });
  });

  it('keeps dealing while a coupon is live, then sleeps', async () => {
    const { ids, players: [alice] } = await arenaWorld(env);
    ok(await alice!.post('/api/arena/coupon').send(picks(ids.tableId, ['rainbow'], 10 * STAR, 3)));
    let settled = 0;
    for (let step = 0; step < 40 && settled < 3; step++) {
      env.clock.advance(5_000);
      const done = await runArenaDeal(env.ctx);
      if (done[0] === 'flop') settled++;
    }
    expect(settled).toBe(3);
    env.clock.advance(60_000);
    expect(await runArenaDeal(env.ctx)).toEqual([null]);
    expect(ok(await alice!.get('/api/arena/coupons')).coupons[0]).toMatchObject({ status: 'completed', roundsSettled: 3 });
  });

  it('deletes hands after the retention window but keeps the all-time flop count', async () => {
    const { ids } = await arenaWorld(env);
    await dealWith(env, ids, ['2h', '7d', 'Jc']);
    await dealWith(env, ids, ['3h', '8d', 'Qc']);
    env.clock.advance(29 * 86_400_000);
    expect(await purgeOldArenaHands(env.ctx)).toBe(0);
    env.clock.advance(2 * 86_400_000);
    expect(await purgeOldArenaHands(env.ctx)).toBe(2);
    expect(await env.db.select().from(hands).where(eq(hands.tableId, ids.tableId))).toHaveLength(0);
    expect(await flopCounter(env.db)).toBe(2);
  });
});
