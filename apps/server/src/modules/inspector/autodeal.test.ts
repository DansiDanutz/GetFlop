import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clubTables, hands } from '../../db/schema/index.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { setupClub } from '../../test/fixtures.js';
import { autoDealTick } from './autodeal.js';
import { checkBudget, releaseBudget } from './budget.js';
import { coupon, setClubSettings } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv({ bettingTimerSeconds: 0 }); });
afterEach(async () => { await env.close(); });

const SEC = 1_000;

async function autoTable(opts: { simulation?: boolean } = {}) {
  const club = await setupClub(env, { players: ['alice'], pointsEach: 100 });
  if (opts.simulation) await setClubSettings(env, club.clubId, { simulation: true });
  const { table } = ok(await club.owner.post('/api/inspector/table').send({ name: 'Robot' }));
  await env.db.update(clubTables).set({ isAutoDeal: true, autoDealSeconds: 20 }).where(eq(clubTables.id, table.id));
  ok(await club.owner.put(`/api/inspector/table/${table.id}/open`).send({}));
  return { ...club, tableId: table.id as string };
}

const handsOf = (tableId: string) => env.db.select().from(hands).where(eq(hands.tableId, tableId)).orderBy(hands.handNumber);

describe('auto-deal engine', () => {
  it('starts a hand, waits the interval, deals a random flop, pauses, repeats', async () => {
    const { tableId, players: [alice] } = await autoTable();
    ok(await alice!.post('/api/player/coupon').send(coupon(tableId, 'rainbow', 100, 2)));

    expect(await autoDealTick(env.ctx)).toEqual({ started: 1, dealt: 0, stopped: false });
    env.clock.advance(19 * SEC);
    expect(await autoDealTick(env.ctx)).toEqual({ started: 0, dealt: 0, stopped: false });
    env.clock.advance(SEC);
    expect(await autoDealTick(env.ctx)).toEqual({ started: 0, dealt: 1, stopped: false });

    const [first] = await handsOf(tableId);
    expect(first).toMatchObject({ status: 'settled', dealtBy: 'auto', dealerId: null, totalBets: 1 });
    expect(first!.card1).toMatch(/^[2-9TJQKA][shdc]$/);

    // Pause before the next hand.
    expect((await autoDealTick(env.ctx)).started).toBe(0);
    env.clock.advance(5 * SEC);
    // A fresh context (as after a restart) picks up exactly where the database says.
    expect(await autoDealTick({ ...env.ctx })).toEqual({ started: 1, dealt: 0, stopped: false });
    expect((await handsOf(tableId)).map((h) => [h.handNumber, h.status])).toEqual([[1, 'settled'], [2, 'betting_open']]);
  });

  it('stops every auto-deal table when the simulation budget trips, until released', async () => {
    const { owner, tableId, players: [alice] } = await autoTable({ simulation: true });
    ok(await alice!.post('/api/player/coupon').send(coupon(tableId, 'rainbow', 100, 1)));
    await autoDealTick(env.ctx);

    const tight = { maxPicks: 0, maxBytes: Number.MAX_SAFE_INTEGER };
    expect(await checkBudget(env.ctx, tight)).toMatchObject({ tripped: true, reason: 'picks' });
    env.clock.advance(30 * SEC);
    expect(await autoDealTick(env.ctx)).toEqual({ started: 0, dealt: 0, stopped: true });
    expect(ok(await owner.get('/api/inspector/dashboard')).alerts.map((a: { code: string }) => a.code)).toContain('sim_budget');
    expect(errCode(await owner.post(`/api/player/table/${tableId}/sim-step`))).toBe('simulation.budget_exceeded');

    await expect(releaseBudget(env.ctx, tight)).rejects.toMatchObject({ code: 'simulation.budget_exceeded' });
    expect(await releaseBudget(env.ctx)).toMatchObject({ tripped: false });
    expect((await autoDealTick(env.ctx)).dealt).toBe(1);
  });
});

describe('simulation steps', () => {
  it('advances a simulation table one step at a time', async () => {
    const { owner, tableId } = await autoTable({ simulation: true });
    const started = ok(await owner.post(`/api/player/table/${tableId}/sim-step`));
    expect(started).toMatchObject({ step: 'started', hand: { handNumber: 1, status: 'betting_open' } });
    const dealt = ok(await owner.post(`/api/player/table/${tableId}/sim-step`));
    expect(dealt).toMatchObject({ step: 'dealt', hand: { handNumber: 1, status: 'settled' } });

    const sim = ok(await owner.get('/api/inspector/simulation'));
    expect(sim.budget).toMatchObject({ tripped: false, maxPicks: 200_000 });
    expect(sim.tables).toEqual([expect.objectContaining({ id: tableId, intervalSeconds: 20, lastHandNumber: 1, liveHand: null })]);
  });

  it('is refused outside the simulation club', async () => {
    const { owner, tableId } = await autoTable();
    expect(errCode(await owner.post(`/api/player/table/${tableId}/sim-step`))).toBe('simulation.club_unsupported');
    expect(errCode(await owner.get('/api/inspector/simulation'))).toBe('simulation.club_unsupported');
  });
});
