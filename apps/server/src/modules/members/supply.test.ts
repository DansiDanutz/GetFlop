import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { grantRole, setupClub } from '../../test/fixtures.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

describe('Points supply screen', () => {
  it('mints once per Idempotency-Key', async () => {
    const { clubId, owner } = await setupClub(env, { players: [], pointsEach: 0 });
    const url = `/api/clubs/${clubId}/points/mint`;
    ok(await owner.post(url).set('Idempotency-Key', 'k-1').send({ amount: 10, reason: 'Float' }));
    ok(await owner.post(url).set('Idempotency-Key', 'k-1').send({ amount: 10, reason: 'Float' }));
    ok(await owner.post(url).set('Idempotency-Key', 'k-2').send({ amount: 5, reason: 'More' }));
    expect(ok(await owner.get(`/api/clubs/${clubId}/points`))).toMatchObject({ pool: 1_500, issued: 1_500, drift: 0 });
  });

  it('lists inspectors\' stock and recent mints for managers only', async () => {
    const { clubId, owner, players: [insp, mgr] } = await setupClub(env, { players: ['insp', 'mgr'], pointsEach: 0 });
    await grantRole(env, clubId, insp!.userId, 'inspector');
    await grantRole(env, clubId, mgr!.userId, 'manager');
    ok(await owner.post(`/api/clubs/${clubId}/points/mint`).send({ amount: 30, reason: 'Friday float' }));
    ok(await owner.post(`/api/clubs/${clubId}/members/${insp!.userId}/stock`).send({ direction: 'give', amount: 12 }));
    const detail = ok(await mgr!.get(`/api/clubs/${clubId}/points/detail`));
    expect(detail.stocks).toEqual([{ userId: insp!.userId, name: 'insp', stockCents: 1_200 }]);
    expect(detail.mints[0]).toMatchObject({ amountCents: 3_000, note: 'Friday float', by: 'owner' });
    expect(detail.reservedCents).toBe(0);
    expect(errCode(await insp!.get(`/api/clubs/${clubId}/points/detail`))).toBe('points.forbidden');
  });

  it('tells the owner when staff run short', async () => {
    const { clubId, owner, players: [mgr, insp, pl] } = await setupClub(env, { players: ['mgr', 'insp', 'pl'], pointsEach: 0 });
    await grantRole(env, clubId, mgr!.userId, 'manager');
    await grantRole(env, clubId, insp!.userId, 'inspector');
    expect(errCode(await mgr!.post(`/api/inspector/player/${pl!.userId}/load`).set('X-Club-Id', clubId).send({ amount: 5 }))).toBe('points.pool_short');
    expect(errCode(await mgr!.post(`/api/clubs/${clubId}/members/${insp!.userId}/stock`).send({ direction: 'give', amount: 2 }))).toBe('points.pool_short');
    expect(errCode(await insp!.post(`/api/inspector/player/${pl!.userId}/load`).set('X-Club-Id', clubId).send({ amount: 3 }))).toBe('points.stock_short');
    expect(errCode(await owner.post(`/api/inspector/player/${pl!.userId}/load`).send({ amount: 3 }))).toBe('points.pool_short_owner');
    const { notices } = ok(await owner.get('/api/clubs/notices'));
    expect(notices.map((n: { code: string }) => n.code).sort()).toEqual(['points.pool_short', 'points.pool_short', 'points.stock_short']);
    const stockShort = notices.find((n: { code: string }) => n.code === 'points.stock_short');
    expect(stockShort.params).toEqual({ staff: 'insp', tried: 3, club: 'Sharks Imperial', have: 0 });
    expect(env.events.named('notice:new').every((e) => e.room === `user:${owner.userId}`)).toBe(true);
  });
});
