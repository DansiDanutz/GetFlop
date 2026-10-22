import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { grantRole, setupClub } from '../../test/fixtures.js';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { playChargeD } from './playCharge.js';
import { balance, days, enforce, ledgerTypes, resetCommerceEnv, topup } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { resetCommerceEnv(); env = await createTestEnv({ bettingTimerSeconds: 0 }); });
afterEach(async () => { await env.close(); resetCommerceEnv(); });

interface Table { clubId: string; owner: Agent; dealer: Agent; alice: Agent; tableId: string }

async function openTable(): Promise<Table> {
  const { clubId, owner, players: [dealer, alice] } = await setupClub(env, { players: ['dealer', 'alice'], pointsEach: 100 });
  await grantRole(env, clubId, dealer!.userId, 'dealer');
  const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'Table 1', game: 'nlh' }));
  ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({ dealerId: dealer!.userId }));
  return { clubId, owner, dealer: dealer!, alice: alice!, tableId: table.id };
}

/** One hand where Alice plays `stakeCents` on Rainbow and Any Pair. */
async function playHand(t: Table, stakeCents: number): Promise<void> {
  ok(await t.dealer.post(`/api/dealer/table/${t.tableId}/start-hand`));
  ok(await t.alice.post('/api/player/coupon').send({ tableId: t.tableId, rounds: 1, selections: [
    { market: 'rainbow', stakeCents }, { market: 'any-pair', stakeCents },
  ] }));
  ok(await t.dealer.post(`/api/dealer/table/${t.tableId}/enter-flop`).send({ card1: 'Qc', card2: '7h', card3: '3s' }));
}

describe('play charge rate', () => {
  it('is 1 D per Point played at the default 1% rate, rounded half up', () => {
    expect(playChargeD(100, 100)).toBe(1);
    expect(playChargeD(1_600_00, 100)).toBe(1_600);
    expect(playChargeD(250, 100)).toBe(3);
    expect(playChargeD(240, 100)).toBe(2);
    expect(playChargeD(100, 0)).toBe(0);
  });
});

describe('the settled-hand play charge', () => {
  it('measures every Ring Game hand as a preview in the pilot (nothing is taken, nothing pauses)', async () => {
    const t = await openTable();
    await playHand(t, 200);
    const dash = ok(await t.owner.get('/api/commerce/club/dashboard'));
    expect(dash.mode).toBe('pilot');
    expect(dash.playCharge).toMatchObject({ pointsCents: 400, diamonds: 4, previewD: 4, chargedD: 0 });
    expect(dash.recentCharges[0]).toMatchObject({ kind: 'hand', status: 'preview', diamonds: 4, pointsCents: 400, label: '1·Table 1' });
    expect(await balance(env, t.clubId)).toBe(0);
  });

  it('takes the charge from the wallet when billing is enforced', async () => {
    const t = await openTable();
    const admin = await enforce(env, t.clubId);
    await topup(admin, t.clubId, 100);
    await playHand(t, 300);
    expect(await balance(env, t.clubId)).toBe(94);
    expect(await ledgerTypes(env, t.clubId)).toEqual(['topup', 'usage_charge']);
    const { charges } = ok(await t.owner.get('/api/commerce/club/charges?limit=5'));
    expect(charges[0]).toMatchObject({ status: 'charged', diamonds: 6 });
  });

  it('records unpaid charges, pauses after the grace, and settles them on top-up', async () => {
    const t = await openTable();
    const admin = await enforce(env, t.clubId);
    await playHand(t, 100);
    const state = ok(await t.owner.get('/api/commerce/club/state'));
    expect(state).toMatchObject({ state: 'usage_grace', pendingD: 2 });

    // Still within the grace: play continues.
    await playHand(t, 100);
    env.clock.advance(days(3));
    const dealer = await env.login('dealer');
    const alice = await env.login('alice');
    expect(errCode(await dealer.post(`/api/dealer/table/${t.tableId}/start-hand`))).toBe('commerce.paused_staff');

    // A hand that was already running is never interrupted, but new coupons are refused while paused.
    expect(errCode(await alice.post('/api/player/coupon').send({ tableId: t.tableId, rounds: 1, selections: [{ market: 'rainbow', stakeCents: 100 }] })))
      .toBe('commerce.game_unavailable');

    await topup(await env.login('admin', { admin: true }), t.clubId, 10);
    expect(await balance(env, t.clubId)).toBe(6);
    expect(await ledgerTypes(env, t.clubId)).toEqual(['topup', 'charge_settlement', 'charge_settlement']);
    ok(await dealer.post(`/api/dealer/table/${t.tableId}/start-hand`));
    const owner = await env.login('owner');
    const codes = ok(await owner.get('/api/commerce/club/dashboard')).messages.map((m: { code: string }) => m.code);
    expect(codes).toEqual(expect.arrayContaining(['charges_pending', 'play_available']));
    expect(admin).toBeDefined();
  });

  it('pauses at once when unpaid charges reach the cap', async () => {
    vi.stubEnv('COMMERCE_USAGE_MAX_PENDING_D', '4');
    const t = await openTable();
    await enforce(env, t.clubId);
    await playHand(t, 200);
    expect(ok(await t.owner.get('/api/commerce/club/state')).state).toBe('restricted');
    expect(errCode(await t.dealer.post(`/api/dealer/table/${t.tableId}/start-hand`))).toBe('commerce.paused_staff');
  });

  it('does not charge hands with no picks', async () => {
    const t = await openTable();
    ok(await t.dealer.post(`/api/dealer/table/${t.tableId}/start-hand`));
    ok(await t.dealer.post(`/api/dealer/table/${t.tableId}/enter-flop`).send({ card1: 'Qc', card2: '7h', card3: '3s' }));
    const { charges } = ok(await t.owner.get('/api/commerce/club/charges'));
    expect(charges).toEqual([]);
  });
});
