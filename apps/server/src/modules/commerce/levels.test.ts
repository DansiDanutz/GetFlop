import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupClub } from '../../test/fixtures.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { runBilling } from './job.js';
import { prorate } from './levelChange.js';
import { billingRow, balance, days, enforce, ledgerTypes, levelId, resetCommerceEnv, topup } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { resetCommerceEnv(); env = await createTestEnv(); });
afterEach(async () => { await env.close(); resetCommerceEnv(); });

describe('proration', () => {
  it('credits the unused part of the paid period against the new price', () => {
    expect(prorate(10_000, 5_000, 30)).toEqual({ proratedD: 5_000, creditD: 5_000 });
    expect(prorate(10_000, 5_000, 10)).toEqual({ proratedD: 8_334, creditD: 1_666 });
    expect(prorate(5_000, 0, 0)).toEqual({ proratedD: 5_000, creditD: 0 });
    expect(prorate(5_000, 20_000, 30)).toEqual({ proratedD: 0, creditD: 20_000 });
  });
});

describe('upgrading a Club Level', () => {
  it('charges the prorated price, applies limits at once and moves the renewal date', async () => {
    const { clubId, owner } = await setupClub(env, { players: [] });
    const admin = await enforce(env, clubId);
    await topup(admin, clubId, 20_000);
    const club100 = await levelId(owner, 'club100');

    const quote = ok(await owner.get(`/api/commerce/club/level/quote?productId=${club100}`)).quote;
    expect(quote).toMatchObject({ direction: 'upgrade', proratedD: 5_000, charged: true, balanceD: 20_000 });

    const up = ok(await owner.post('/api/commerce/club/level/upgrade').set('Idempotency-Key', 'k1').send({ productId: club100 }));
    expect(up).toMatchObject({ level: 'club100', chargedD: 5_000 });
    expect(await balance(env, clubId)).toBe(15_000);
    expect(new Date(up.renewsAt).getTime()).toBe(env.clock.now().getTime() + days(30));

    // Replaying the same Idempotency-Key does not charge twice.
    ok(await owner.post('/api/commerce/club/level/upgrade').set('Idempotency-Key', 'k1').send({ productId: club100 }));
    expect(await balance(env, clubId)).toBe(15_000);

    // Ten days later, Club 500: 10,000 − floor(5,000 × 20 / 30) = 6,667.
    env.clock.advance(days(10));
    const club500 = await levelId(owner, 'club500');
    const second = ok(await owner.post('/api/commerce/club/level/upgrade').send({ productId: club500 }));
    expect(second.chargedD).toBe(6_667);
    expect(await balance(env, clubId)).toBe(15_000 - 6_667);
    const dash = ok(await owner.get('/api/commerce/club/dashboard'));
    expect(dash.limits.find((l: { resource: string }) => l.resource === 'ringGames')).toMatchObject({ limit: 5 });
    expect(await ledgerTypes(env, clubId)).toEqual(['topup', 'level_charge', 'level_charge']);
  });

  it('refuses without enough Diamonds, and refuses sideways moves', async () => {
    const { clubId, owner } = await setupClub(env, { players: [] });
    const admin = await enforce(env, clubId);
    await topup(admin, clubId, 1_000);
    const club100 = await levelId(owner, 'club100');
    const res = await owner.post('/api/commerce/club/level/upgrade').send({ productId: club100 });
    expect(errCode(res)).toBe('commerce.level_insufficient_diamonds');
    expect(res.body.error.params).toEqual({ costD: 5_000, balanceD: 1_000, shortfallD: 4_000 });
    const starter = await levelId(owner, 'starter');
    expect(errCode(await owner.post('/api/commerce/club/level/upgrade').send({ productId: starter }))).toBe('commerce.level_not_an_upgrade');
    expect(errCode(await owner.post('/api/commerce/club/level/downgrade').send({ productId: club100 }))).toBe('commerce.level_not_a_downgrade');
  });

  it('charges nothing in the pilot but still applies the Level', async () => {
    const { clubId, owner } = await setupClub(env, { players: [] });
    const club100 = await levelId(owner, 'club100');
    const up = ok(await owner.post('/api/commerce/club/level/upgrade').send({ productId: club100 }));
    expect(up).toMatchObject({ level: 'club100', chargedD: 0, previewD: 5_000 });
    expect(await balance(env, clubId)).toBe(0);
    const dash = ok(await owner.get('/api/commerce/club/dashboard'));
    expect(dash).toMatchObject({ mode: 'pilot', state: 'preview', level: { code: 'club100' } });
    expect(dash.recentCharges[0]).toMatchObject({ kind: 'level', status: 'preview', diamonds: 5_000 });
  });

  it('is owner only', async () => {
    const { owner, players: [alice] } = await setupClub(env, { players: ['alice'] });
    expect(errCode(await alice!.get('/api/commerce/club/dashboard'))).toBe('commerce.forbidden');
    ok(await owner.get('/api/commerce/club/state'));
  });
});

describe('renewals and downgrades', () => {
  it('renews every 30 days, and a downgrade applies at renewal', async () => {
    const { clubId, owner } = await setupClub(env, { players: [] });
    const admin = await enforce(env, clubId);
    await topup(admin, clubId, 30_000);
    ok(await owner.post('/api/commerce/club/level/upgrade').send({ productId: await levelId(owner, 'club500') }));
    const club100 = await levelId(owner, 'club100');
    const scheduled = ok(await owner.post('/api/commerce/club/level/downgrade').send({ productId: club100 }));
    expect(scheduled.pendingDowngrade).toMatchObject({ code: 'club100' });
    // Keep the current Level, then schedule again.
    ok(await owner.delete('/api/commerce/club/level/downgrade'));
    expect((await billingRow(env, clubId)).pendingDowngradeCode).toBeNull();
    ok(await owner.post('/api/commerce/club/level/downgrade').send({ productId: club100 }));

    env.clock.advance(days(30));
    await runBilling(env.ctx);
    const b = await billingRow(env, clubId);
    expect(b).toMatchObject({ levelCode: 'club100', pendingDowngradeCode: null });
    expect(await balance(env, clubId)).toBe(30_000 - 10_000 - 5_000);
  });

  it('keeps the Level when usage is over the lower limit', async () => {
    const { clubId, owner } = await setupClub(env, { players: [] });
    ok(await owner.post('/api/commerce/club/level/upgrade').send({ productId: await levelId(owner, 'club100') }));
    for (const name of ['T1', 'T2']) {
      const { table } = ok(await owner.post('/api/inspector/table').send({ name }));
      ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({}));
    }
    const res = ok(await owner.post('/api/commerce/club/level/downgrade').send({ productId: await levelId(owner, 'starter') }));
    expect(res.blockers).toEqual([{ resource: 'ringGames', used: 2, newLimit: 1 }]);
    env.clock.advance(days(30));
    await runBilling(env.ctx);
    expect((await billingRow(env, clubId)).levelCode).toBe('club100');
    const again = await env.login('owner');
    const { messages } = ok(await again.get('/api/commerce/club/dashboard'));
    expect(messages.map((m: { code: string }) => m.code)).toContain('level_downgrade_blocked');
  });

  it('marks an unpaid renewal overdue, pauses after the deadline and recovers on top-up', async () => {
    const { clubId, owner } = await setupClub(env, { players: [] });
    const admin = await enforce(env, clubId);
    await topup(admin, clubId, 5_000);
    ok(await owner.post('/api/commerce/club/level/upgrade').send({ productId: await levelId(owner, 'club100') }));
    env.clock.advance(days(30));
    await runBilling(env.ctx);
    const owner2 = await env.login('owner');
    expect(ok(await owner2.get('/api/commerce/club/state')).state).toBe('past_due_grace');
    expect((await billingRow(env, clubId)).levelCode).toBe('club100');

    env.clock.advance(days(4));
    await runBilling(env.ctx);
    expect(ok(await owner2.get('/api/commerce/club/state')).state).toBe('restricted');
    expect(ok(await owner2.get('/api/commerce/club/notice')).notice).toMatchObject({ kind: 'paused' });
    const codes = ok(await owner2.get('/api/commerce/club/dashboard')).messages.map((m: { code: string }) => m.code);
    expect(codes).toEqual(expect.arrayContaining(['renewal_overdue', 'play_paused']));

    await topup(await env.login('admin', { admin: true }), clubId, 5_000);
    const b = await billingRow(env, clubId);
    expect(b.renewalOverdueSince).toBeNull();
    expect(b.renewsAt!.getTime()).toBe(env.clock.now().getTime() + days(30));
    expect(ok(await owner2.get('/api/commerce/club/state')).state).not.toBe('restricted');
    expect(await balance(env, clubId)).toBe(0);
  });
});

describe('the free-club rule', () => {
  it('locks a second Starter club and refuses a downgrade that would make two free clubs', async () => {
    const { clubId: first, owner } = await setupClub(env, { players: [] });
    const { club: second } = ok(await owner.post('/api/clubs').send({ name: 'Second House', acceptClubTerms: true }));
    ok(await owner.post('/api/clubs/select').send({ clubId: second.id }));
    const dash = ok(await owner.get('/api/commerce/club/dashboard'));
    expect(dash.level).toMatchObject({ code: 'starter', levelLocked: true, freeClubName: 'Sharks Imperial' });

    // Paying for the second club unlocks it.
    ok(await owner.post('/api/commerce/club/level/upgrade').send({ productId: await levelId(owner, 'club100') }));
    expect(ok(await owner.get('/api/commerce/club/dashboard')).level.levelLocked).toBe(false);
    // Moving it back to Starter while the first club is free is refused.
    const res = await owner.post('/api/commerce/club/level/downgrade').send({ productId: await levelId(owner, 'starter') });
    expect(errCode(res)).toBe('commerce.level_free_club_held');
    expect(res.body.error.params).toEqual({ freeClub: 'Sharks Imperial' });
    expect(first).toBeTruthy();
  });
});
