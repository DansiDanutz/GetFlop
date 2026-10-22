import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diamondOrders } from '../../db/schema/index.js';
import { setupClub } from '../../test/fixtures.js';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { signPayload, verifySignature } from './stripe.js';
import { debit } from './wallet.js';
import { balance, days, ledgerTypes, resetCommerceEnv } from './testkit.js';

const WEBHOOK_SECRET = 'whsec_test_only';
const FAKE_KEY = 'sk_test_fake_never_sent';

let env: TestEnv;
let stripeCalls: { url: string; body: string }[];

/** Intercepts fetch to api.stripe.com: no request ever leaves the machine. */
function fakeStripe(refundOk = true): void {
  stripeCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    stripeCalls.push({ url, body: init.body });
    if (!url.startsWith('https://api.stripe.com/')) throw new Error(`unexpected fetch ${url}`);
    if (url.endsWith('/checkout/sessions')) {
      return new Response(JSON.stringify({ id: `cs_test_${stripeCalls.length}`, url: 'https://checkout.stripe.test/pay' }), { status: 200 });
    }
    if (url.endsWith('/refunds')) {
      return refundOk
        ? new Response(JSON.stringify({ id: 're_test_1', status: 'succeeded' }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'charge already refunded' } }), { status: 400 });
    }
    return new Response('{}', { status: 404 });
  }));
}

beforeEach(async () => {
  resetCommerceEnv();
  env = await createTestEnv();
});
afterEach(async () => { vi.unstubAllGlobals(); await env.close(); resetCommerceEnv(); });

async function firstPack(owner: Agent) {
  const { packs } = ok(await owner.get('/api/commerce/club/packs'));
  return packs[0] as { versionId: string; productId: string; diamonds: number; priceCents: number };
}

function sessionEvent(id: string, orderId: string, amountSubtotal: number, extra: Record<string, unknown> = {}) {
  return {
    id, type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_test_1', object: 'checkout.session', payment_status: 'paid', currency: 'eur',
      amount_subtotal: amountSubtotal, amount_total: amountSubtotal + 480, total_details: { amount_tax: 480 },
      payment_intent: 'pi_test_1', metadata: { orderId, kind: 'diamonds' }, customer_details: { address: { country: 'GR' } },
      ...extra,
    } },
  };
}

async function postWebhook(event: unknown, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const sig = signPayload(payload, secret, Math.floor(env.clock.now().getTime() / 1000));
  return request(env.url).post('/api/commerce/stripe/webhook')
    .set('Content-Type', 'application/json').set('Stripe-Signature', sig).send(payload);
}

describe('checkout', () => {
  it('needs card payments configured and the immediate-delivery consent', async () => {
    const { owner } = await setupClub(env, { players: [] });
    const pack = await firstPack(owner);
    expect(errCode(await owner.post('/api/commerce/club/checkout').send({ packVersionId: pack.versionId, locale: 'en' })))
      .toBe('commerce.consent_required');
    expect(errCode(await owner.post('/api/commerce/club/checkout').send({ packVersionId: pack.versionId, locale: 'en', consent: true })))
      .toBe('commerce.payments_unavailable');
    expect(errCode(await owner.post('/api/commerce/club/checkout').send({ packVersionId: 'nope', consent: true })))
      .toBe('commerce.payments_unavailable');
  });

  it('credits Diamonds through the DEV simulated payment (never in production)', async () => {
    vi.stubEnv('COMMERCE_DEV_PAYMENTS', '1');
    const { clubId, owner } = await setupClub(env, { players: [] });
    const pack = await firstPack(owner);
    const { orderId, dev } = ok(await owner.post('/api/commerce/club/checkout').send({ packVersionId: pack.versionId, locale: 'en', consent: true }));
    expect(dev).toBe(true);
    ok(await owner.post(`/api/commerce/club/orders/${orderId}/simulate`));
    expect(await balance(env, clubId)).toBe(pack.diamonds);
    expect(ok(await owner.get(`/api/commerce/club/orders/${orderId}`)).order.status).toBe('paid');

    vi.stubEnv('NODE_ENV', 'production');
    expect(errCode(await owner.post('/api/commerce/club/checkout').send({ packVersionId: pack.versionId, consent: true })))
      .toBe('commerce.payments_unavailable');
  });

  it('creates a Stripe Checkout Session in test mode with the net amount', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', FAKE_KEY);
    fakeStripe();
    const { owner } = await setupClub(env, { players: [] });
    const pack = await firstPack(owner);
    const res = ok(await owner.post('/api/commerce/club/checkout').send({ packVersionId: pack.versionId, locale: 'el', consent: true }));
    expect(res).toMatchObject({ url: 'https://checkout.stripe.test/pay', dev: false, netCents: pack.priceCents });
    expect(stripeCalls).toHaveLength(1);
    const body = decodeURIComponent(stripeCalls[0]!.body);
    expect(body).toContain(`line_items[0][price_data][unit_amount]=${pack.priceCents}`);
    expect(body).toContain(`metadata[orderId]=${res.orderId}`);
    expect(body).toContain('locale=el');
    const [order] = await env.db.select().from(diamondOrders).where(eq(diamondOrders.id, res.orderId));
    expect(order).toMatchObject({ status: 'pending', isTest: true, stripeSessionId: 'cs_test_1' });
  });
});

describe('the Stripe webhook', () => {
  async function pendingOrder() {
    vi.stubEnv('STRIPE_SECRET_KEY', FAKE_KEY);
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
    fakeStripe();
    const club = await setupClub(env, { players: [] });
    const pack = await firstPack(club.owner);
    const { orderId } = ok(await club.owner.post('/api/commerce/club/checkout').send({ packVersionId: pack.versionId, consent: true }));
    return { ...club, pack, orderId: orderId as string };
  }

  it('verifies the signature (HMAC SHA-256 over "t.body", with a time tolerance)', () => {
    const now = 1_800_000_000;
    const header = signPayload('{"a":1}', 'secret', now);
    expect(() => verifySignature('{"a":1}', header, 'secret', now)).not.toThrow();
    expect(() => verifySignature('{"a":2}', header, 'secret', now)).toThrow();
    expect(() => verifySignature('{"a":1}', header, 'other', now)).toThrow();
    expect(() => verifySignature('{"a":1}', header, 'secret', now + 301)).toThrow();
    expect(() => verifySignature('{"a":1}', undefined, 'secret', now)).toThrow();
    expect(() => verifySignature('{"a":1}', 't=abc,v1=00', 'secret', now)).toThrow();
  });

  it('credits a paid order exactly once and records the receipt state', async () => {
    const { clubId, pack, orderId } = await pendingOrder();
    expect(errCode(await postWebhook(sessionEvent('evt_1', orderId, pack.priceCents), 'whsec_wrong'))).toBe('commerce.webhook_signature_invalid');
    expect(await balance(env, clubId)).toBe(0);

    expect(ok(await postWebhook(sessionEvent('evt_1', orderId, pack.priceCents)))).toEqual({ handled: 'credited' });
    expect(ok(await postWebhook(sessionEvent('evt_1', orderId, pack.priceCents)))).toEqual({ handled: 'duplicate' });
    expect(ok(await postWebhook(sessionEvent('evt_2', orderId, pack.priceCents)))).toEqual({ handled: 'duplicate' });
    expect(await balance(env, clubId)).toBe(pack.diamonds);
    const [order] = await env.db.select().from(diamondOrders).where(eq(diamondOrders.id, orderId));
    expect(order).toMatchObject({ status: 'paid', vatCents: 480, totalCents: pack.priceCents + 480, country: 'GR', receiptStatus: 'skipped' });
  });

  it('credits nothing and raises an alert when the amount does not match', async () => {
    const { clubId, pack, orderId } = await pendingOrder();
    expect(ok(await postWebhook(sessionEvent('evt_3', orderId, pack.priceCents - 1)))).toEqual({ handled: 'mismatch' });
    expect(await balance(env, clubId)).toBe(0);
    const admin = await env.login('admin', { admin: true });
    const payments = ok(await admin.get('/api/commerce/admin/payments'));
    expect(payments.alerts[0]).toMatchObject({ kind: 'payment_mismatch', orderId });
    ok(await admin.post('/api/commerce/admin/alerts/read'));
    expect(ok(await admin.get('/api/commerce/admin/payments')).unreadAlerts).toBe(0);
  });

  it('expires abandoned sessions and alerts on chargebacks', async () => {
    const { orderId } = await pendingOrder();
    ok(await postWebhook({ id: 'evt_4', type: 'checkout.session.expired', data: { object: { id: 'cs_test_1', metadata: { orderId } } } }));
    const [order] = await env.db.select().from(diamondOrders).where(eq(diamondOrders.id, orderId));
    expect(order!.status).toBe('expired');
    expect(ok(await postWebhook({ id: 'evt_5', type: 'charge.dispute.created', data: { object: { amount: 5000, reason: 'fraudulent', payment_intent: 'pi_test_1' } } })))
      .toEqual({ handled: 'alerted' });
  });
});

describe('refunds', () => {
  async function paidOrder(refundOk = true) {
    vi.stubEnv('STRIPE_SECRET_KEY', FAKE_KEY);
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
    fakeStripe(refundOk);
    const club = await setupClub(env, { players: [] });
    const pack = await firstPack(club.owner);
    const { orderId } = ok(await club.owner.post('/api/commerce/club/checkout').send({ packVersionId: pack.versionId, consent: true }));
    ok(await postWebhook(sessionEvent('evt_paid', orderId, pack.priceCents)));
    return { ...club, pack, orderId: orderId as string, admin: await env.login('admin', { admin: true }) };
  }

  it('returns the payment and takes back only the unspent Diamonds', async () => {
    const { clubId, pack, orderId, admin } = await paidOrder();
    // 500 D of the purchase are spent before the refund.
    vi.stubEnv('COMMERCE_PILOT', '0');
    ok(await admin.put(`/api/commerce/admin/clubs/${clubId}/enforcement`).send({ enabled: true }));
    await env.db.transaction((tx) => debit(tx, { clubId, type: 'usage_charge', amount: 500, at: env.clock.now() }));

    expect(errCode(await admin.post(`/api/commerce/admin/orders/${orderId}/refund`).send({ ground: 'changed_mind' }))).toBe('commerce.refund_ground_invalid');
    const refund = ok(await admin.post(`/api/commerce/admin/orders/${orderId}/refund`).send({ ground: 'duplicate' }));
    expect(refund).toMatchObject({ diamondsTakenBack: pack.diamonds - 500, diamondsShort: 500, refundCents: pack.priceCents + 480 });
    expect(await balance(env, clubId)).toBe(0);
    expect(await ledgerTypes(env, clubId)).toEqual(['topup', 'usage_charge', 'refund']);
    expect(stripeCalls.at(-1)!.body).toContain('payment_intent=pi_test_1');
    expect(errCode(await admin.post(`/api/commerce/admin/orders/${orderId}/refund`).send({ ground: 'duplicate' }))).toBe('commerce.refund_not_refundable');
    const payments = ok(await admin.get('/api/commerce/admin/payments'));
    expect(payments.alerts.map((a: { kind: string }) => a.kind)).toContain('refund_short');
    const audit = ok(await admin.get('/api/commerce/admin/audit'));
    expect(audit.entries.map((e: { action: string }) => e.action)).toContain('refund');
  });

  it('closes 14 days after the payment', async () => {
    const late = await paidOrder();
    env.clock.advance(days(15));
    const admin = await env.login('admin', { admin: true });
    const res = await admin.post(`/api/commerce/admin/orders/${late.orderId}/refund`).send({ ground: 'our_fault' });
    expect(errCode(res)).toBe('commerce.refund_window_closed');
    expect(res.body.error.params).toEqual({ days: 14 });
  });

  it('reports refund_failed when Stripe refuses', async () => {
    const { clubId, pack, orderId, admin } = await paidOrder(false);
    expect(errCode(await admin.post(`/api/commerce/admin/orders/${orderId}/refund`).send({ ground: 'our_fault' }))).toBe('commerce.refund_failed');
    expect(await balance(env, clubId)).toBe(pack.diamonds);
  });
});
