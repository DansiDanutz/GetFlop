import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupClub } from '../../test/fixtures.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { athensNoon } from './adminClubs.js';
import { runBilling } from './job.js';
import { balance, billingRow, days, enforce, levelId, resetCommerceEnv, topup } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { resetCommerceEnv(); env = await createTestEnv(); });
afterEach(async () => { await env.close(); resetCommerceEnv(); });

type Product = { id: string; code: string; kind: string; inForceVersionId: string | null; versions: { id: string; version: number; status: string }[] };

describe('the platform catalogue', () => {
  it('versions prices immutably: draft → publish → withdraw, with an impact preview and audit', async () => {
    const { owner } = await setupClub(env, { players: [] });
    const admin = await env.login('admin', { admin: true });
    expect(errCode(await owner.get('/api/commerce/admin/catalogue'))).toBe('auth.forbidden');

    const { products } = ok(await admin.get('/api/commerce/admin/catalogue'));
    const club100 = (products as Product[]).find((p) => p.code === 'club100')!;
    expect(club100.versions).toHaveLength(1);

    const { version: draft } = ok(await admin.post(`/api/commerce/admin/products/${club100.id}/drafts`));
    expect(draft).toMatchObject({ version: 2, status: 'draft', priceDiamonds: 5_000 });
    ok(await admin.put(`/api/commerce/admin/versions/${draft.id}`).send({
      priceDiamonds: 6_000, limits: { members: 120, ringGames: 2, tournaments: 1, rooms: 1, broadcasts: 10 },
    }));
    const { preview } = ok(await admin.get(`/api/commerce/admin/versions/${draft.id}/preview`));
    expect(preview).toMatchObject({ price: { fromD: 5_000, toD: 6_000 }, clubs: 0 });
    expect(preview.limitsDiff).toEqual(expect.arrayContaining([{ resource: 'members', from: 100, to: 120 }]));

    ok(await admin.post(`/api/commerce/admin/versions/${draft.id}/publish`));
    expect(errCode(await admin.put(`/api/commerce/admin/versions/${draft.id}`).send({ priceDiamonds: 1 }))).toBe('commerce.version_not_draft');
    expect(errCode(await admin.delete(`/api/commerce/admin/versions/${draft.id}`))).toBe('commerce.version_not_draft');
    const quote = ok(await owner.get(`/api/commerce/club/level/quote?productId=${club100.id}`)).quote;
    expect(quote.priceD).toBe(6_000);

    ok(await admin.post(`/api/commerce/admin/versions/${draft.id}/withdraw`));
    expect(ok(await owner.get(`/api/commerce/club/level/quote?productId=${club100.id}`)).quote.priceD).toBe(5_000);

    const { version: scrap } = ok(await admin.post(`/api/commerce/admin/products/${club100.id}/drafts`));
    ok(await admin.delete(`/api/commerce/admin/versions/${scrap.id}`));

    const { entries } = ok(await admin.get('/api/commerce/admin/audit'));
    expect(entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining([
      'draft_created', 'draft_saved', 'version_published', 'version_withdrawn', 'draft_deleted',
    ]));
  });

  it('creates products, puts them on sale, and only sells published versions', async () => {
    const { owner } = await setupClub(env, { players: [] });
    const admin = await env.login('admin', { admin: true });
    const { product } = ok(await admin.post('/api/commerce/admin/products').send({ code: 'pack_777', kind: 'diamond_pack', nameEn: '777 Diamonds', nameEl: '777 Διαμάντια' }));
    expect(errCode(await admin.post('/api/commerce/admin/products').send({ code: 'pack_777', kind: 'diamond_pack', nameEn: 'x', nameEl: 'x' })))
      .toBe('commerce.product_code_taken');
    const { version } = ok(await admin.post(`/api/commerce/admin/products/${product.id}/drafts`));
    expect(errCode(await admin.post(`/api/commerce/admin/versions/${version.id}/publish`))).toBe('commerce.version_incomplete');
    ok(await admin.put(`/api/commerce/admin/versions/${version.id}`).send({ diamonds: 777, priceCents: 777 }));
    ok(await admin.post(`/api/commerce/admin/versions/${version.id}/publish`));
    const count = async () => ok(await owner.get('/api/commerce/club/packs')).packs.length as number;
    expect(await count()).toBe(4);
    ok(await admin.put(`/api/commerce/admin/products/${product.id}`).send({ lifecycle: 'active' }));
    expect(await count()).toBe(5);
    const { entries } = ok(await admin.get('/api/commerce/admin/audit'));
    expect(entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['product_created', 'product_updated']));
  });

  it('announces a play-charge rate change at least 30 days ahead', async () => {
    await setupClub(env, { players: [] });
    const admin = await env.login('admin', { admin: true });
    const { products } = ok(await admin.get('/api/commerce/admin/catalogue'));
    const rate = (products as Product[]).find((p) => p.kind === 'turnover_rate')!;
    const { version } = ok(await admin.post(`/api/commerce/admin/products/${rate.id}/drafts`));
    const soon = new Date(env.clock.now().getTime() + days(10)).toISOString();
    ok(await admin.put(`/api/commerce/admin/versions/${version.id}`).send({ rateBp: 150, effectiveFrom: soon }));
    const res = await admin.post(`/api/commerce/admin/versions/${version.id}/publish`);
    expect(errCode(res)).toBe('commerce.rate_notice_too_short');
    expect(res.body.error.params).toEqual({ days: 30 });
    const later = new Date(env.clock.now().getTime() + days(31)).toISOString();
    ok(await admin.put(`/api/commerce/admin/versions/${version.id}`).send({ effectiveFrom: later }));
    ok(await admin.post(`/api/commerce/admin/versions/${version.id}/publish`));
    expect(errCode(await admin.put(`/api/commerce/admin/versions/${version.id}`).send({ rateBp: 300 }))).toBe('validation.invalid');
  });

  it('applies a new Level price at the next renewal, never to the current paid period', async () => {
    const { clubId, owner } = await setupClub(env, { players: [] });
    const admin = await enforce(env, clubId);
    await topup(admin, clubId, 20_000);
    const club100 = await levelId(owner, 'club100');
    ok(await owner.post('/api/commerce/club/level/upgrade').send({ productId: club100 }));
    const { version } = ok(await admin.post(`/api/commerce/admin/products/${club100}/drafts`));
    ok(await admin.put(`/api/commerce/admin/versions/${version.id}`).send({ priceDiamonds: 7_000 }));
    const { preview } = ok(await admin.get(`/api/commerce/admin/versions/${version.id}/preview`));
    expect(preview.clubs).toBe(1);
    ok(await admin.post(`/api/commerce/admin/versions/${version.id}/publish`));
    expect(await balance(env, clubId)).toBe(15_000);
    env.clock.advance(days(30));
    await runBilling(env.ctx);
    expect(await balance(env, clubId)).toBe(8_000);
    expect((await billingRow(env, clubId)).levelVersionId).toBe(version.id);
  });
});

describe('billing start', () => {
  it('computes 12:00 Greek time, checks notice, and switches every club on at the start', async () => {
    expect(athensNoon('2026-12-01')!.toISOString()).toBe('2026-12-01T10:00:00.000Z');
    expect(athensNoon('2026-07-01')!.toISOString()).toBe('2026-07-01T09:00:00.000Z');
    expect(athensNoon('2026-02-30')).toBeNull();

    const { clubId, owner } = await setupClub(env, { players: [] });
    const admin = await env.login('admin', { admin: true });
    expect(errCode(await admin.post('/api/commerce/admin/billing-start').send({ day: 'soon' }))).toBe('commerce.billing_start_date_invalid');
    expect(errCode(await admin.post('/api/commerce/admin/billing-start').send({ day: '2026-09-25' }))).toBe('commerce.billing_start_too_soon');
    ok(await admin.post('/api/commerce/admin/billing-start').send({ day: '2026-10-05' }));
    expect(ok(await owner.get('/api/commerce/club/dashboard')).billingStart).toMatchObject({ day: '2026-10-05' });
    ok(await admin.delete('/api/commerce/admin/billing-start'));
    ok(await admin.post('/api/commerce/admin/billing-start').send({ day: '2026-10-05' }));

    env.clock.advance(days(12));
    await runBilling(env.ctx);
    expect((await billingRow(env, clubId)).enforced).toBe(true);
    const admin2 = await env.login('admin', { admin: true });
    expect(errCode(await admin2.post('/api/commerce/admin/billing-start').send({ day: '2026-12-05' }))).toBe('commerce.billing_start_already_live');
    const { clubs } = ok(await admin2.get('/api/commerce/admin/clubs'));
    expect(clubs[0]).toMatchObject({ id: clubId, level: 'starter', billing: 'pilot' });
    ok(await admin2.post('/api/commerce/admin/billing-start/return-to-pilot'));
    expect((await billingRow(env, clubId)).enforced).toBe(false);
  });
});
