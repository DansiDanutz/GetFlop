import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { arenaWorld, dealWith, picks, STAR } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { vi.unstubAllEnvs(); await env.close(); });

describe('GET /admin/platform/arena', () => {
  it('is for platform admins only', async () => {
    const { players: [alice] } = await arenaWorld(env);
    expect(errCode(await alice!.get('/api/admin/platform/arena'))).toBe('auth.forbidden');
  });

  it('reports Stars, sales, play (within the retention window), markets and the board', async () => {
    vi.stubEnv('COMMERCE_DEV_PAYMENTS', '1');
    const { ids, players: [alice, bob] } = await arenaWorld(env, ['alice', 'bob']);
    const { orderId } = ok(await alice!.post('/api/arena/checkout').send({ packId: 'stars_5k', consent: true }));
    ok(await alice!.post(`/api/arena/orders/${orderId}/simulate-paid`).send({}));
    ok(await alice!.post('/api/arena/coupon').send(picks(ids.tableId, ['rainbow'], 100 * STAR)));
    ok(await bob!.post('/api/arena/coupon').send(picks(ids.tableId, ['any-pair'], 100 * STAR)));
    await dealWith(env, ids, ['2h', '7d', 'Jc']);
    ok(await bob!.post('/api/arena/board-visibility').send({ hidden: true }));

    const admin = await env.login('root', { admin: true });
    const report = ok(await admin.get('/api/admin/platform/arena?period=week'));
    expect(report).toMatchObject({
      period: 'week', players: 2,
      stars: {
        allTime: { grantedCents: 4_000 * STAR, boughtCents: 5_000 * STAR, inWalletsCents: 9_030 * STAR, houseHoldsCents: -30 * STAR, driftCents: 0 },
        period: { grantedCents: 4_000 * STAR, refilledCents: 0, boughtCents: 5_000 * STAR },
      },
      sales: { orders: 1, buyers: 1, chargedCents: 247, vatCents: 48, keptCents: 199 },
      play: { hands: 1, playedCents: 200 * STAR, paidCents: 230 * STAR, holdCents: -30 * STAR, holdPct: null, flopsAllTime: 1, retentionDays: 30 },
      board: { players: 2, flops: 2, wins: 1, hidden: 1 },
    });
    expect(report.sales.packs[0]).toEqual({ id: 'stars_5k', orders: 1, starsCents: 5_000 * STAR });
    expect(report.play.markets).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'rainbow', picks: 1, won: 1, returnPct: 230 })]));

    env.clock.advance(40 * 86_400_000);
    const again = await env.login('root', { admin: true });
    const later = ok(await again.get('/api/admin/platform/arena?period=all'));
    expect(later.play).toMatchObject({ hands: 0, flopsAllTime: 1 });
    expect(later.sales.orders).toBe(1);
    expect(ok(await again.get('/api/admin/platform/arena?period=day')).stars.period.boughtCents).toBe(0);
  });
});
