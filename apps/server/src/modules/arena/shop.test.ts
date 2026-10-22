import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { setStarPaymentProvider } from './payments.js';
import { fulfilStarOrder } from './shop.js';
import { starSupply } from './stars.js';
import { arenaWorld, STAR } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { vi.unstubAllEnvs(); setStarPaymentProvider(null); await env.close(); });

const buy = (a: Agent, packId: string) => a.post('/api/arena/checkout').send({ packId, consent: true, locale: 'en' });
const devMode = () => vi.stubEnv('COMMERCE_DEV_PAYMENTS', '1');

describe('the Stars shop', () => {
  it('reports card payments unavailable when no payment provider is configured', async () => {
    const { players: [alice] } = await arenaWorld(env);
    const shop = ok(await alice!.get('/api/arena/packs'));
    expect(shop).toMatchObject({ open: true, cardPayments: false, capDayCents: 3_000, capMonthCents: 10_000, vatPct: 24 });
    expect(shop.packs[0]).toMatchObject({ id: 'stars_5k', starsCents: 5_000 * STAR, priceCents: 199, totalCents: 247, available: true });
    expect(errCode(await buy(alice!, 'stars_5k'))).toBe('commerce.card_unavailable');
  });

  it('validates the pack, the consent and the shop state', async () => {
    devMode();
    const { players: [alice] } = await arenaWorld(env);
    expect(errCode(await buy(alice!, 'stars_1m'))).toBe('arena.unknown_pack');
    expect(errCode(await alice!.post('/api/arena/checkout').send({ packId: 'stars_5k', consent: false }))).toBe('validation.invalid');
    vi.stubEnv('ARENA_SHOP_OPEN', '0');
    expect(errCode(await buy(alice!, 'stars_5k'))).toBe('arena.shop_closed');
    expect(ok(await alice!.get('/api/arena/packs')).packs[0]).toMatchObject({ available: false, unavailableReason: 'shop_closed' });
  });

  it('allows one open checkout, cancels without charge and credits a paid order once', async () => {
    devMode();
    const { players: [alice, bob] } = await arenaWorld(env, ['alice', 'bob']);
    const first = ok(await buy(alice!, 'stars_15k'));
    expect(first.url).toBe(`http://localhost:5173/#/arena?order=${first.orderId}&stars=success&simulate=1`);
    expect(errCode(await buy(alice!, 'stars_5k'))).toBe('arena.checkout_open');
    expect(ok(await alice!.get('/api/arena/packs'))).toMatchObject({ openOrderId: first.orderId, packs: [{ unavailableReason: 'checkout_open' }, {}, {}] });

    expect(errCode(await bob!.post(`/api/arena/orders/${first.orderId}/cancel`).send({}))).toBe('arena.unknown_order');
    expect(ok(await alice!.post(`/api/arena/orders/${first.orderId}/cancel`).send({}))).toEqual({ status: 'cancelled', charged: false });
    expect(errCode(await alice!.post(`/api/arena/orders/${first.orderId}/simulate-paid`).send({}))).toBe('arena.unknown_order');

    const second = ok(await buy(alice!, 'stars_15k'));
    const paid = ok(await alice!.post(`/api/arena/orders/${second.orderId}/simulate-paid`).send({}));
    expect(paid).toMatchObject({ status: 'paid', balanceCents: 17_000 * STAR });
    await fulfilStarOrder(env.ctx, second.orderId);
    expect(ok(await alice!.get('/api/arena/summary')).balanceCents).toBe(17_000 * STAR);
    expect(errCode(await alice!.post(`/api/arena/orders/${second.orderId}/cancel`).send({}))).toBe('arena.cancel_failed');
    expect(ok(await alice!.get(`/api/arena/orders/${second.orderId}`))).toMatchObject({ status: 'paid', starsCents: 15_000 * STAR });
    expect(await starSupply(env.db)).toMatchObject({ drift: 0 });
  });

  it('enforces the daily and monthly spending caps', async () => {
    devMode();
    vi.stubEnv('ARENA_CAP_MONTH_CENTS', '4000');
    const { players: [alice] } = await arenaWorld(env);
    const payFor = async (packId: string) => {
      const { orderId } = ok(await buy(alice!, packId));
      ok(await alice!.post(`/api/arena/orders/${orderId}/simulate-paid`).send({}));
    };
    await payFor('stars_40k'); // €12.39
    await payFor('stars_40k'); // €24.78 today
    const res = await buy(alice!, 'stars_40k');
    expect(errCode(res)).toBe('arena.cap_day');
    expect(res.body.error.params).toEqual({ left: 522, cap: 3_000 });
    const shop = ok(await alice!.get('/api/arena/packs'));
    expect(shop).toMatchObject({ spentDayCents: 2_478, leftDayCents: 522, leftMonthCents: 1_522 });
    expect(shop.packs.map((p: { unavailableReason: string | null }) => p.unavailableReason)).toEqual([null, 'cap_day', 'cap_day']);

    env.clock.advance(86_400_000);
    await payFor('stars_40k');
    expect(errCode(await buy(alice!, 'stars_40k'))).toBe('arena.cap_month');
  });

  it('stops counting an abandoned checkout after it expires', async () => {
    devMode();
    const { players: [alice] } = await arenaWorld(env);
    ok(await buy(alice!, 'stars_5k'));
    env.clock.advance(31 * 60_000);
    ok(await buy(alice!, 'stars_5k'));
  });

  it('uses an installed payment provider and cancels the order if it fails', async () => {
    const { players: [alice] } = await arenaWorld(env);
    setStarPaymentProvider({ name: 'stripe', createCheckout: async () => { throw new Error('stripe down'); } });
    expect(errCode(await buy(alice!, 'stars_5k'))).toBe('commerce.payments_failed');
    setStarPaymentProvider({ name: 'stripe', createCheckout: async (_ctx, req) => ({ url: `https://pay.example/${req.orderId}`, ref: 'cs_1' }) });
    const { url, orderId } = ok(await buy(alice!, 'stars_5k'));
    expect(url).toBe(`https://pay.example/${orderId}`);
    expect(errCode(await alice!.post(`/api/arena/orders/${orderId}/simulate-paid`).send({}))).toBe('auth.forbidden');
  });
});
