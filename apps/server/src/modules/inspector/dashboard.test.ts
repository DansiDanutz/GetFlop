import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { grantRole, setupClub } from '../../test/fixtures.js';
import { coupon, openFloor, playHand, setClubSettings } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv({ bettingTimerSeconds: 0 }); });
afterEach(async () => { await env.close(); });

const MIN = 60_000;

describe('GET /inspector/dashboard', () => {
  it('shows ALL CLEAR with a dealing table and nothing pending', async () => {
    const f = await openFloor(env);
    await playHand(f, ['Qc', '7h', '3s']);
    ok(await f.dealer.post(`/api/dealer/table/${f.tableId}/start-hand`));
    const d = ok(await f.owner.get('/api/inspector/dashboard'));
    expect(d.allClear).toBe(true);
    expect(d.alerts).toEqual([]);
    expect(d.tables).toHaveLength(1);
    expect(d.tables[0]).toMatchObject({ name: 'Main', group: 'dealing', totalHands: 1, activeHandNumber: 2, dealerName: 'dealer' });
    expect(d.groups.find((g: { group: string }) => g.group === 'dealing').tableIds).toEqual([f.tableId]);
    expect(d.stats).toMatchObject({ openTables: 1, dealing: 1, pendingPoints: 0 });
  });

  it('builds the attention list with the clock: requests, no dealer, idle 8 min, level lock', async () => {
    const f = await openFloor(env);
    await playHand(f, ['Qc', '7h', '3s']);
    const { table: second } = ok(await f.owner.post('/api/inspector/table').send({ name: 'Second' }));
    await setClubSettings(env, f.clubId, { levelLocked: false });
    await env.db.execute(`update clubs set level = 'club500' where id = '${f.clubId}'`);
    ok(await f.owner.put(`/api/inspector/table/${second.id}/open`).send({}));
    ok(await f.alice.post('/api/player/reload-request').send({ amount: 5 }));

    env.clock.advance(7 * MIN);
    let codes = ok(await f.owner.get('/api/inspector/dashboard')).alerts.map((a: { code: string }) => a.code);
    expect(codes).toEqual(['requests_waiting', 'no_dealer']);

    env.clock.advance(MIN);
    const d = ok(await f.owner.get('/api/inspector/dashboard'));
    codes = d.alerts.map((a: { code: string }) => a.code);
    expect(codes).toEqual(['requests_waiting', 'no_dealer', 'idle']);
    expect(d.alerts[0]).toMatchObject({ severity: 'danger', params: { n: 1 } });
    expect(d.alerts[1]).toMatchObject({ tableId: second.id, params: { table: 'Second' } });
    expect(d.alerts[2]).toMatchObject({ severity: 'attention', tableId: f.tableId, params: { table: 'Main', dealer: 'dealer', minutes: 8 } });
    expect(d.allClear).toBe(false);

    await setClubSettings(env, f.clubId, { levelLocked: true });
    expect(ok(await f.owner.get('/api/inspector/dashboard')).alerts[0]).toMatchObject({ severity: 'danger', code: 'level_locked' });
  });

  it('groups a fresh never-played closed table as READY and counts live coupons', async () => {
    const f = await openFloor(env);
    const { table } = ok(await f.owner.post('/api/inspector/table').send({ name: 'Fresh' }));
    ok(await f.alice.post('/api/player/coupon').send(coupon(f.tableId, 'rainbow', 200, 3)));
    const d = ok(await f.owner.get('/api/inspector/dashboard'));
    const byId = (id: string) => d.tables.find((t: { id: string }) => t.id === id);
    expect(byId(table.id).group).toBe('ready');
    expect(byId(f.tableId)).toMatchObject({ group: 'waiting', liveCoupons: 1, couponExposureCents: 600 });
    expect(d.stats).toMatchObject({ liveCoupons: 1, exposureCents: 600 });
  });

  it('is staff only', async () => {
    const { players: [p] } = await setupClub(env, { players: ['pat'] });
    expect(errCode(await p!.get('/api/inspector/dashboard'))).toBe('club.capability_missing');
  });

  it('lets an inspector read it', async () => {
    const { clubId, players: [insp] } = await setupClub(env, { players: ['ines'] });
    await grantRole(env, clubId, insp!.userId, 'inspector');
    expect(ok(await insp!.get('/api/inspector/dashboard')).allClear).toBe(true);
  });
});
