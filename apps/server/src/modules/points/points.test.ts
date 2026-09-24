import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ledgerEntries } from '../../db/schema/index.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { grantRole, setupClub } from '../../test/fixtures.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

describe('Points supply and staff movements', () => {
  it('mints, sends out, claims back and always adds up', async () => {
    const { clubId, owner, players: [player] } = await setupClub(env, { pointsEach: 100 });
    expect(ok(await player!.get('/api/player/balance')).balanceCents).toBe(10_000);
    ok(await owner.post(`/api/inspector/player/${player!.userId}/withdraw`).set('X-Club-Id', clubId).send({ amount: '25.50' }));
    expect(ok(await player!.get('/api/player/balance')).balanceCents).toBe(7_450);
    const s = ok(await owner.get(`/api/clubs/${clubId}/points`));
    expect(s).toMatchObject({ pool: 2_550, inWallets: 7_450, issued: 10_000, drift: 0 });
    expect(ok(await owner.get('/api/inspector/wallet-drift'))).toMatchObject({ checked: 1, driftingCount: 0 });
  });

  it('never sends more than the pool holds', async () => {
    const { clubId, owner, players: [player] } = await setupClub(env, { pointsEach: 0 });
    const res = await owner.post(`/api/inspector/player/${player!.userId}/load`).set('X-Club-Id', clubId).send({ amount: 5 });
    expect(errCode(res)).toBe('points.pool_short_owner');
    expect(res.body.error.params).toMatchObject({ balance: 0, needed: 500 });
  });

  it.each(['0', '-1', '1.234', 'abc'])('rejects amount %s', async (amount) => {
    const { clubId, owner } = await setupClub(env, { players: [], pointsEach: 0 });
    expect(errCode(await owner.post(`/api/clubs/${clubId}/points/mint`).send({ amount, reason: 'x' }))).toBe('points.amount_invalid');
  });

  it('requires a reason to mint', async () => {
    const { clubId, owner } = await setupClub(env, { players: [], pointsEach: 0 });
    expect(errCode(await owner.post(`/api/clubs/${clubId}/points/mint`).send({ amount: 5 }))).toBe('points.reason_required');
  });

  it('lets an inspector send only from their own stock', async () => {
    const { clubId, owner, players: [insp, player] } = await setupClub(env, { players: ['insp', 'player'], pointsEach: 0 });
    await grantRole(env, clubId, insp!.userId, 'inspector');
    ok(await owner.post(`/api/clubs/${clubId}/points/mint`).send({ amount: 50, reason: 'Stock' }));
    expect(errCode(await insp!.post(`/api/inspector/player/${player!.userId}/load`).send({ amount: 5 }))).toBe('points.stock_short');
    expect(errCode(await owner.post(`/api/clubs/${clubId}/members/${player!.userId}/stock`).send({ direction: 'give', amount: 5 })))
      .toBe('points.stock_not_inspector');
    ok(await owner.post(`/api/clubs/${clubId}/members/${insp!.userId}/stock`).send({ direction: 'give', amount: 20 }));
    ok(await insp!.post(`/api/inspector/player/${player!.userId}/load`).send({ amount: 5 }));
    expect(ok(await insp!.get('/api/inspector/requests')).myStock).toBe(1_500);
    expect(errCode(await owner.post(`/api/clubs/${clubId}/members/${insp!.userId}/stock`).send({ direction: 'take', amount: 16 })))
      .toBe('points.stock_take_more_than_held');
    expect(ok(await owner.get(`/api/clubs/${clubId}/points`))).toMatchObject({ pool: 3_000, inStocks: 1_500, inWallets: 500, drift: 0 });
  });
});

describe('player Points requests', () => {
  it('requests Points, gets approved, returns some, and is told', async () => {
    const { clubId, owner, players: [player] } = await setupClub(env, { pointsEach: 0 });
    ok(await owner.post(`/api/clubs/${clubId}/points/mint`).send({ amount: 100, reason: 'Float' }));
    ok(await player!.post('/api/player/reload-request').send({ amount: 30 }));
    expect(errCode(await player!.post('/api/player/reload-request').send({ amount: 30 }))).toBe('points.request_pending');
    const { reloads } = ok(await owner.get('/api/inspector/requests').set('X-Club-Id', clubId));
    ok(await owner.post(`/api/inspector/request/${reloads[0].id}/approve`).set('X-Club-Id', clubId).send({}));
    expect(ok(await player!.get('/api/player/balance')).balanceCents).toBe(3_000);
    expect(errCode(await player!.post('/api/player/cashout-request').send({ amount: 31 }))).toBe('points.over_balance');
    ok(await player!.post('/api/player/cashout-request').send({ amount: 10 }));
    const { cashouts } = ok(await owner.get('/api/inspector/requests').set('X-Club-Id', clubId));
    ok(await owner.post(`/api/inspector/request/${cashouts[0].id}/reject`).set('X-Club-Id', clubId).send({ reason: 'Ask at the desk' }));
    const mine = ok(await player!.get('/api/player/requests'));
    expect(mine.reloads[0].status).toBe('approved');
    expect(mine.cashouts[0]).toMatchObject({ status: 'rejected', rejectionReason: 'Ask at the desk' });
    expect(env.events.named('request:actioned').map((e) => (e.payload as { status: string }).status)).toEqual(['approved', 'rejected']);
    const history = ok(await owner.get('/api/inspector/requests/history?days=30').set('X-Club-Id', clubId));
    expect(history.items).toHaveLength(2);
  });

  it('keeps the ledger append-only with balances after each move', async () => {
    const { clubId } = await setupClub(env, { pointsEach: 10 });
    const rows = await env.db.select().from(ledgerEntries);
    expect(rows.map((r) => r.kind)).toEqual(['mint', 'deposit']);
    expect(rows[1]).toMatchObject({ clubId, amountCents: 1_000, fromBalanceAfter: 0, toBalanceAfter: 1_000 });
  });
});
