import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diamondLedger, diamondLots } from '../../db/schema/index.js';
import { setupClub } from '../../test/fixtures.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { runBilling } from './job.js';
import { credit, debit, nextExpiry } from './wallet.js';
import { balance, days, resetCommerceEnv } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { resetCommerceEnv(); env = await createTestEnv(); });
afterEach(async () => { await env.close(); resetCommerceEnv(); });

const add = (clubId: string, amount: number) => env.db.transaction((tx) =>
  credit(tx, { clubId, type: 'topup', amount, source: 'topup', at: env.clock.now() }));
const spend = (clubId: string, amount: number) => env.db.transaction((tx) =>
  debit(tx, { clubId, type: 'usage_charge', amount, at: env.clock.now() }));

describe('Diamond lots', () => {
  it('spends the oldest lot first and expires what is left after 12 months', async () => {
    const { clubId } = await setupClub(env, { players: [] });
    await add(clubId, 1_000);
    env.clock.advance(days(100));
    await add(clubId, 500);
    await spend(clubId, 700);

    const lots = await env.db.select().from(diamondLots).where(eq(diamondLots.clubId, clubId)).orderBy(diamondLots.createdAt);
    expect(lots.map((l) => l.remaining)).toEqual([300, 500]);
    expect(await nextExpiry(env.db, clubId, env.clock.now())).toMatchObject({ amount: 300 });

    // 365 days after the first purchase: its 300 D expire; the newer lot is untouched.
    env.clock.advance(days(266));
    await runBilling(env.ctx);
    expect(await balance(env, clubId)).toBe(500);
    const ledger = await env.db.select().from(diamondLedger).where(eq(diamondLedger.clubId, clubId)).orderBy(diamondLedger.createdAt);
    expect(ledger.map((r) => [r.type, r.amount, r.balanceAfter])).toEqual([
      ['topup', 1_000, 1_000], ['topup', 500, 1_500], ['usage_charge', -700, 800], ['expiry', -300, 500],
    ]);
    // Running the job again expires nothing more.
    await runBilling(env.ctx);
    expect(await balance(env, clubId)).toBe(500);
  });

  it('refuses to spend more than the balance and keeps lots and balance in step', async () => {
    const { clubId } = await setupClub(env, { players: [] });
    await add(clubId, 100);
    await expect(spend(clubId, 101)).rejects.toMatchObject({ code: 'commerce.level_insufficient_diamonds' });
    expect(await balance(env, clubId)).toBe(100);
  });

  it('validates admin top-ups and replays an Idempotency-Key', async () => {
    const { clubId } = await setupClub(env, { players: [] });
    const admin = await env.login('admin', { admin: true });
    const url = `/api/commerce/admin/clubs/${clubId}/topup`;
    expect(errCode(await admin.post(url).send({ diamonds: 1.5, reference: 'X' }))).toBe('commerce.topup_amount_invalid');
    expect(errCode(await admin.post(url).send({ diamonds: 10, reference: ' ' }))).toBe('commerce.topup_reference_required');
    ok(await admin.post(url).set('Idempotency-Key', 'same').send({ diamonds: 10, reference: 'INV-1' }));
    ok(await admin.post(url).set('Idempotency-Key', 'same').send({ diamonds: 10, reference: 'INV-1' }));
    expect(await balance(env, clubId)).toBe(10);
    const owner = await env.login('owner');
    expect(errCode(await owner.post(url).send({ diamonds: 10, reference: 'X' }))).toBe('auth.forbidden');
  });
});
