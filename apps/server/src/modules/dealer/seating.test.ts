import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { grantRole } from '../../test/fixtures.js';
import { dealerWorld, makeAutoDeal, secondClub } from './testWorld.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv({ bettingTimerSeconds: 30 }); });
afterEach(async () => { await env.close(); });

describe('sitting without approval', () => {
  it('lists open tables, seats immediately and blocks a second table', async () => {
    const { dealer, tables: [t1, t2] } = await dealerWorld(env);
    const before = ok(await dealer.get('/api/dealer/available-tables'));
    expect(before).toMatchObject({ needsApproval: false, pending: null });
    expect(before.tables.map((t: { id: string }) => t.id).sort()).toEqual([t1, t2].sort());

    const sat = ok(await dealer.post(`/api/dealer/table/${t1}/sit`));
    expect(sat).toMatchObject({ status: 'seated', table: { id: t1, dealerId: dealer.userId } });
    expect(ok(await dealer.get('/api/dealer/tables')).tables).toEqual([expect.objectContaining({ id: t1, clubName: 'Sharks Imperial' })]);
    expect(ok(await dealer.get('/api/dealer/available-tables')).tables.map((t: { id: string }) => t.id)).toEqual([t2]);

    const res = await dealer.post(`/api/dealer/table/${t2}/sit`);
    expect(errCode(res)).toBe('dealer.holds_other');
    expect(res.body.error.params).toMatchObject({ table: 'Table 1' });
  });

  it('refuses tables that are taken, closed or auto-dealt, and non-dealers', async () => {
    const { owner, dealer, alice, clubId, tables: [t1, t2] } = await dealerWorld(env);
    await grantRole(env, clubId, alice.userId, 'dealer');
    ok(await alice.post(`/api/dealer/table/${t1}/sit`));
    const taken = await dealer.post(`/api/dealer/table/${t1}/sit`);
    expect(errCode(taken)).toBe('dealer.table_taken');
    expect(taken.body.error.params).toMatchObject({ table: 'Table 1' });

    ok(await owner.put(`/api/inspector/table/${t2}/close`));
    expect(errCode(await dealer.post(`/api/dealer/table/${t2}/sit`))).toBe('dealer.table_taken');

    const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'Robot' }));
    ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({}));
    await makeAutoDeal(env, table.id);
    expect(errCode(await dealer.post(`/api/dealer/table/${table.id}/sit`))).toBe('dealer.auto_table');
    expect(ok(await dealer.get('/api/dealer/available-tables')).tables).toHaveLength(0);

    const bob = await env.login('floor');
    expect(errCode(await bob.get('/api/dealer/available-tables'))).toBe('club.capability_missing');
  });

  it('refuses a dealer with live coupons on the table', async () => {
    const { owner, clubId, tables: [t1] } = await dealerWorld(env);
    ok(await owner.post(`/api/clubs/${clubId}/points/mint`).send({ amount: 10, reason: 'Own play' }));
    ok(await owner.post(`/api/inspector/player/${owner.userId}/load`).send({ amount: 10 }));
    ok(await owner.post('/api/player/coupon').send({ tableId: t1, rounds: 2, selections: [{ market: 'rainbow', stakeCents: 100 }] }));
    await grantRole(env, clubId, owner.userId, 'dealer');
    const res = await owner.post(`/api/dealer/table/${t1}/sit`);
    expect(errCode(res)).toBe('dealer.own_live_coupons');
    expect(res.body.error.params).toMatchObject({ n: 1, table: 'Table 1' });
  });

  it('stands up, and refuses hand actions by someone not seated', async () => {
    const { dealer, tables: [t1] } = await dealerWorld(env);
    expect(errCode(await dealer.post(`/api/dealer/table/${t1}/leave`))).toBe('dealer.not_dealing');
    expect(errCode(await dealer.post(`/api/dealer/table/${t1}/start-hand`))).toBe('dealer.not_dealing');
    ok(await dealer.post(`/api/dealer/table/${t1}/sit`));
    ok(await dealer.post(`/api/dealer/table/${t1}/start-hand`));
    const live = await dealer.post(`/api/dealer/table/${t1}/leave`);
    expect(errCode(live)).toBe('dealer.hand_live');
    expect(live.body.error.params).toMatchObject({ hand: 1 });
    ok(await dealer.post(`/api/dealer/table/${t1}/cancel-hand`));
    ok(await dealer.post(`/api/dealer/table/${t1}/leave`));
    expect(ok(await dealer.get('/api/dealer/tables')).tables).toHaveLength(0);
  });
});

describe('switching and the held table', () => {
  it('switches tables in one step, and rejects a stale or live held table', async () => {
    const { dealer, tables: [t1, t2] } = await dealerWorld(env);
    ok(await dealer.post(`/api/dealer/table/${t1}/sit`));
    expect(errCode(await dealer.post(`/api/dealer/table/${t2}/switch`).send({ heldTableId: t2 }))).toBe('dealer.switch_stale');

    ok(await dealer.post(`/api/dealer/table/${t1}/start-hand`));
    const live = await dealer.post(`/api/dealer/table/${t2}/switch`).send({ heldTableId: t1 });
    expect(errCode(live)).toBe('dealer.hand_live');
    ok(await dealer.post(`/api/dealer/table/${t1}/cancel-hand`));

    const switched = ok(await dealer.post(`/api/dealer/table/${t2}/switch`).send({ heldTableId: t1 }));
    expect(switched).toMatchObject({ status: 'seated', table: { id: t2 } });
    const avail = ok(await dealer.get('/api/dealer/available-tables'));
    expect(avail.tables.map((t: { id: string }) => t.id)).toEqual([t1]);
    expect(errCode(await dealer.post(`/api/dealer/table/${t1}/switch`).send({}))).toBe('validation.invalid');
  });

  it('knows about a seat in another club', async () => {
    const { dealer, clubId, tables: [t1] } = await dealerWorld(env);
    const other = await secondClub(env, dealer, clubId);
    ok(await dealer.post(`/api/dealer/table/${other.tableId}/sit`).set('X-Club-Id', other.clubId));

    const res = await dealer.post(`/api/dealer/table/${t1}/sit`);
    expect(errCode(res)).toBe('dealer.you_deal_elsewhere');
    expect(res.body.error.params).toEqual({ table: 'River 1', club: 'Riverside' });
    expect(ok(await dealer.get('/api/dealer/tables')).tables[0]).toMatchObject({ id: other.tableId, clubId: other.clubId, clubName: 'Riverside' });

    ok(await dealer.post(`/api/dealer/table/${other.tableId}/start-hand`).set('X-Club-Id', other.clubId));
    const blocked = await dealer.post(`/api/dealer/table/${t1}/switch`).send({ heldTableId: other.tableId });
    expect(errCode(blocked)).toBe('dealer.held_hand_live');
    expect(blocked.body.error.params).toEqual({ table: 'River 1', club: 'Riverside' });
    const leaveBlocked = await dealer.post('/api/dealer/held/leave');
    expect(errCode(leaveBlocked)).toBe('dealer.held_hand_live');

    ok(await dealer.post(`/api/dealer/table/${other.tableId}/cancel-hand`).set('X-Club-Id', other.clubId));
    expect(ok(await dealer.post('/api/dealer/held/leave'))).toEqual({ table: 'River 1', club: 'Riverside' });
    expect(errCode(await dealer.post('/api/dealer/held/leave'))).toBe('dealer.not_dealing');

    ok(await dealer.post(`/api/dealer/table/${other.tableId}/sit`).set('X-Club-Id', other.clubId));
    expect(ok(await dealer.post(`/api/dealer/table/${t1}/switch`).send({ heldTableId: other.tableId }))).toMatchObject({ status: 'seated' });
    expect(env.events.log.some((e) => e.event === 'floor:changed' && e.room === `staff:${other.clubId}`)).toBe(true);
  });
});

describe('floor assignment and dealer notices', () => {
  it('refuses to assign a dealer who is busy elsewhere and leaves them a notice', async () => {
    const { dealer, floor, tables: [t1, t2] } = await dealerWorld(env);
    ok(await dealer.post(`/api/dealer/table/${t1}/sit`));
    env.events.clear();
    expect(errCode(await floor.post(`/api/inspector/table/${t2}/assign`).send({ dealerId: dealer.userId }))).toBe('dealer.busy_elsewhere');
    expect(errCode(await floor.put(`/api/inspector/table/${t2}/open`).send({ dealerId: dealer.userId }))).toBe('dealer.busy_elsewhere');

    const { notices } = ok(await dealer.get('/api/dealer/notices'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ code: 'dealer.wanted_elsewhere', params: { wantedBy: 'floor', table: 'Table 1', club: 'Sharks Imperial' } });
    const pushed = env.events.named('notice:new');
    expect(pushed[0]).toMatchObject({ room: `user:${dealer.userId}`, payload: { code: 'dealer.wanted_elsewhere' } });

    ok(await dealer.post(`/api/dealer/notices/${notices[0].id}/read`));
    expect(ok(await dealer.get('/api/dealer/notices')).notices).toHaveLength(0);
    // Someone else's notice cannot be marked read.
    expect(ok(await floor.post(`/api/dealer/notices/${notices[0].id}/read`))).toEqual({ read: false });
  });

  it('tells the dealer when the floor assigns or unseats them', async () => {
    const { dealer, floor, tables: [t1] } = await dealerWorld(env);
    ok(await floor.post(`/api/inspector/table/${t1}/assign`).send({ dealerId: dealer.userId }));
    expect(env.events.named('dealer:seat').at(-1)).toMatchObject({
      room: `user:${dealer.userId}`, payload: { status: 'assigned', tableId: t1, tableName: 'Table 1' },
    });
    ok(await floor.post(`/api/inspector/table/${t1}/unseat`));
    expect(env.events.named('dealer:seat').at(-1)!.payload).toMatchObject({ status: 'unseated', tableId: t1 });
  });
});
