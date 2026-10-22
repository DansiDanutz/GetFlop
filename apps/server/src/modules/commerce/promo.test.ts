import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupClub } from '../../test/fixtures.js';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { balance, days, ledgerTypes, resetCommerceEnv } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { resetCommerceEnv(); env = await createTestEnv(); });
afterEach(async () => { await env.close(); resetCommerceEnv(); });

const create = (admin: Agent, body: Record<string, unknown>) =>
  admin.post('/api/commerce/admin/promo-codes').send({ kind: 'gift', value: 500, days: 30, uses: 10, ...body });

describe('promo codes (admin)', () => {
  it('validates every field', async () => {
    const { clubId } = await setupClub(env, { players: [] });
    const admin = await env.login('admin', { admin: true });
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: 'free' }, 'commerce.promo_kind_invalid'],
      [{ kind: 'percent', value: 100 }, 'commerce.promo_value_invalid'],
      [{ value: 0 }, 'commerce.promo_value_invalid'],
      [{ days: 366 }, 'commerce.promo_days_invalid'],
      [{ uses: 10_001 }, 'commerce.promo_uses_invalid'],
      [{ clubId: 'nope' }, 'commerce.promo_club_invalid'],
      [{ kind: 'percent', value: 10, packId: clubId }, 'commerce.promo_pack_invalid'],
      [{ code: 'no spaces' }, 'commerce.promo_code_invalid'],
      [{ code: 'abc' }, 'commerce.promo_code_invalid'],
    ];
    for (const [body, code] of cases) expect(errCode(await create(admin, body))).toBe(code);
    ok(await create(admin, { code: 'WELCOME-1' }));
    expect(errCode(await create(admin, { code: 'welcome-1' }))).toBe('commerce.promo_code_taken');
    const generated = ok(await create(admin, {})).code;
    expect(generated.code).toMatch(/^[A-Z0-9]{8}$/);
    const owner = await env.login('owner');
    expect(errCode(await create(owner, {}))).toBe('auth.forbidden');
  });
});

describe('redeeming codes (owner)', () => {
  it('adds gift Diamonds once per club, then the code is used up', async () => {
    const { clubId, owner } = await setupClub(env, { players: [] });
    const { clubId: otherClub, owner: other } = await setupClub(env, { players: [], owner: 'other', clubName: 'Other Club' });
    const admin = await env.login('admin', { admin: true });
    ok(await create(admin, { code: 'GIFT500', uses: 1 }));

    expect(ok(await owner.post('/api/commerce/club/promo/check').send({ code: 'gift500' }))).toMatchObject({ kind: 'gift', giftD: 500 });
    expect(errCode(await owner.post('/api/commerce/club/checkout').send({ packVersionId: 'x', consent: true, promoCode: 'GIFT500' })))
      .toBe('commerce.payments_unavailable');
    expect(ok(await owner.post('/api/commerce/club/promo/redeem').send({ code: 'GIFT500' }))).toEqual({ giftD: 500, balanceD: 500 });
    expect(await ledgerTypes(env, clubId)).toEqual(['grant']);
    expect(errCode(await owner.post('/api/commerce/club/promo/redeem').send({ code: 'GIFT500' }))).toBe('commerce.promo_already_used');
    expect(errCode(await other.post('/api/commerce/club/promo/redeem').send({ code: 'GIFT500' }))).toBe('commerce.promo_used_up');
    expect(await balance(env, otherClub)).toBe(0);
    const { codes } = ok(await admin.get('/api/commerce/admin/promo-codes'));
    expect(codes[0]).toMatchObject({ code: 'GIFT500', status: 'used_up', redemptions: { used: 1, reserved: 0, released: 0 } });
  });

  it('refuses unknown, other-club, withdrawn and expired codes', async () => {
    const { owner } = await setupClub(env, { players: [] });
    const { clubId: otherClub } = await setupClub(env, { players: [], owner: 'other', clubName: 'Other Club' });
    const admin = await env.login('admin', { admin: true });
    const theirs = ok(await create(admin, { code: 'THEIRS', clubId: otherClub })).code;
    const pulled = ok(await create(admin, { code: 'PULLED' })).code;
    ok(await create(admin, { code: 'SHORT', days: 1 }));
    ok(await admin.post(`/api/commerce/admin/promo-codes/${pulled.id}/disable`));

    const check = (code: string) => owner.post('/api/commerce/club/promo/check').send({ code });
    expect(errCode(await check('NOPE'))).toBe('commerce.promo_not_found');
    expect(errCode(await check('THEIRS'))).toBe('commerce.promo_not_found');
    expect(errCode(await check('PULLED'))).toBe('commerce.promo_inactive');
    env.clock.advance(days(2));
    const again = await env.login('owner');
    expect(errCode(await again.post('/api/commerce/club/promo/check').send({ code: 'SHORT' }))).toBe('commerce.promo_expired');
    const { messages } = ok(await env.login('other').then((o) => o.get('/api/commerce/club/dashboard')));
    expect(messages[0]).toMatchObject({ code: 'promo_received', params: { code: theirs.code } });
  });

  it('discounts a pack at card checkout and marks the code used once paid', async () => {
    vi.stubEnv('COMMERCE_DEV_PAYMENTS', '1');
    const { owner } = await setupClub(env, { players: [] });
    const admin = await env.login('admin', { admin: true });
    const { packs } = ok(await owner.get('/api/commerce/club/packs'));
    const [small, big] = packs;
    ok(await create(admin, { code: 'TENOFF', kind: 'percent', value: 10, packId: small.productId }));

    const pay = (packVersionId: string, promoCode: string) =>
      owner.post('/api/commerce/club/checkout').send({ packVersionId, consent: true, promoCode });
    expect(errCode(await owner.post('/api/commerce/club/promo/redeem').send({ code: 'TENOFF' }))).toBe('commerce.promo_card_only');
    expect(errCode(await pay(big.versionId, 'TENOFF'))).toBe('commerce.promo_wrong_pack');
    const order = ok(await pay(small.versionId, 'TENOFF'));
    expect(order.netCents).toBe(Math.round(small.priceCents * 0.9));
    ok(await owner.post(`/api/commerce/club/orders/${order.orderId}/simulate`));
    const { codes } = ok(await admin.get('/api/commerce/admin/promo-codes'));
    expect(codes[0].redemptions).toEqual({ used: 1, reserved: 0, released: 0 });

    ok(await create(admin, { code: 'FREE100', value: 100 }));
    expect(errCode(await pay(small.versionId, 'FREE100'))).toBe('commerce.promo_gift_not_here');
  });
});
