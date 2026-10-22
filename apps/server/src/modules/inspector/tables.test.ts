import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { grantRole, setupClub } from '../../test/fixtures.js';
import { coupon, openFloor, playHand } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv({ bettingTimerSeconds: 0 }); });
afterEach(async () => { await env.close(); });

const PNG = `data:image/png;base64,${'A'.repeat(400)}`;

describe('delete / archive a table', () => {
  it('deletes a never-played table for good', async () => {
    const f = await openFloor(env);
    const { table } = ok(await f.owner.post('/api/inspector/table').send({ name: 'Spare' }));
    const preview = ok(await f.owner.get(`/api/inspector/table/${table.id}/delete-preview`));
    expect(preview).toEqual({ mode: 'delete', history: { hands: 0, coupons: 0 }, dealer: null, blocked: null });
    expect(ok(await f.owner.delete(`/api/inspector/table/${table.id}`).send({ expectMode: 'delete' }))).toMatchObject({ mode: 'delete', name: 'Spare' });
    expect(errCode(await f.owner.get(`/api/inspector/table/${table.id}/delete-preview`))).toBe('table.not_found');
  });

  it('archives a played table, stands the dealer up, and keeps its history in reports', async () => {
    const f = await openFloor(env);
    await playHand(f, ['Qc', '7h', '3s'], async () => {
      ok(await f.alice.post('/api/player/coupon').send(coupon(f.tableId, 'rainbow', 200)));
    });
    const preview = ok(await f.owner.get(`/api/inspector/table/${f.tableId}/delete-preview`));
    expect(preview).toMatchObject({ mode: 'archive', history: { hands: 1, coupons: 1 }, dealer: { id: f.dealer.userId }, blocked: null });
    expect(ok(await f.owner.delete(`/api/inspector/table/${f.tableId}`)).mode).toBe('archive');
    expect(ok(await f.owner.get('/api/inspector/tables')).tables).toHaveLength(0);
    expect(ok(await f.owner.get('/api/inspector/dashboard')).tables).toHaveLength(0);
    expect(env.events.named('dealer:seat').at(-1)!.payload).toMatchObject({ status: 'unseated' });
    const results = ok(await f.owner.get('/api/inspector/results?all=1'));
    expect(results.hands).toHaveLength(1);
    expect(results.hands[0]).toMatchObject({ tableName: 'Main', playedCents: 200 });
  });

  it('is blocked by a live hand, then by riding coupons', async () => {
    const f = await openFloor(env);
    ok(await f.dealer.post(`/api/dealer/table/${f.tableId}/start-hand`));
    expect(ok(await f.owner.get(`/api/inspector/table/${f.tableId}/delete-preview`)).blocked)
      .toEqual({ code: 'table_delete.hand_live', params: { hand: 1 } });
    const res = await f.owner.delete(`/api/inspector/table/${f.tableId}`);
    expect(errCode(res)).toBe('table_delete.hand_live');
    expect(res.body.error.params).toEqual({ hand: 1 });

    ok(await f.alice.post('/api/player/coupon').send(coupon(f.tableId, 'rainbow', 100, 3)));
    ok(await f.dealer.post(`/api/dealer/table/${f.tableId}/enter-flop`).send({ card1: 'Ah', card2: 'Ad', card3: 'Kh' }));
    expect(errCode(await f.owner.delete(`/api/inspector/table/${f.tableId}`))).toBe('table_delete.coupons_riding');
  });

  it('refuses when the table changed since the confirm', async () => {
    const f = await openFloor(env);
    expect(ok(await f.owner.get(`/api/inspector/table/${f.tableId}/delete-preview`)).mode).toBe('delete');
    await playHand(f, ['Qc', '7h', '3s']);
    expect(errCode(await f.owner.delete(`/api/inspector/table/${f.tableId}`).send({ expectMode: 'delete' }))).toBe('table_delete.changed');
  });

  it('is staff only', async () => {
    const f = await openFloor(env);
    expect(errCode(await f.alice.delete(`/api/inspector/table/${f.tableId}`))).toBe('club.capability_missing');
  });
});

describe('lobby card, join code, table info', () => {
  it('saves game, featured and photo, and validates them', async () => {
    const f = await openFloor(env);
    const url = `/api/inspector/table/${f.tableId}/lobby-card`;
    expect(ok(await f.owner.put(url).send({ game: 'plo', featured: true, photo: PNG })).table)
      .toMatchObject({ game: 'plo', featured: true, photoUrl: PNG });
    expect(ok(await f.owner.put(url).send({ game: 'other', featured: false })).table.photoUrl).toBe(PNG);
    expect(ok(await f.owner.put(url).send({ game: 'nlh', featured: false, photo: null })).table.photoUrl).toBeNull();
    expect(errCode(await f.owner.put(url).send({ game: 'stud', featured: false }))).toBe('table_card.game_invalid');
    expect(errCode(await f.owner.put(url).send({ game: 'nlh', featured: false, photo: 'data:image/gif;base64,AAAA' }))).toBe('table_card.photo_invalid');
    const big = `data:image/jpeg;base64,${'A'.repeat(420_000)}`;
    const res = await f.owner.put(url).send({ game: 'nlh', featured: false, photo: big });
    expect(errCode(res)).toBe('table_card.photo_too_large');
    expect(res.body.error.params).toEqual({ maxKb: 300 });
  });

  it('regenerates the join code (owner or manager only) and resolves table info by code', async () => {
    const f = await openFloor(env);
    const { tables: [before] } = ok(await f.owner.get('/api/inspector/tables'));
    const info = ok(await f.alice.get(`/api/tables/${before.joinCode.toLowerCase()}/info`));
    expect(info).toMatchObject({ id: f.tableId, name: 'Main', kind: 'cash', status: 'open', activeHandStatus: null, club: { id: f.clubId } });

    const { joinCode } = ok(await f.owner.post(`/api/tables/${f.tableId}/generate-code`));
    expect(joinCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(joinCode).not.toBe(before.joinCode);
    expect(errCode(await f.alice.get(`/api/tables/${before.joinCode}/info`))).toBe('table.not_found');
    expect(ok(await f.alice.get(`/api/tables/${joinCode}/info`)).id).toBe(f.tableId);

    await grantRole(env, f.clubId, f.bob.userId, 'inspector');
    expect(errCode(await f.bob.post(`/api/tables/${f.tableId}/generate-code`))).toBe('club.capability_missing');
  });
});

describe('create with markets and limits', () => {
  it('applies the allowed markets, and limits only for owner or manager', async () => {
    const f = await openFloor(env);
    const body = { name: 'Picky', allowedBetTypeIds: ['rainbow', 'any-pair'], minBetCents: 200, maxBetCents: 3_000, maxCouponCommitmentCents: 10_000 };
    const { table } = ok(await f.owner.post('/api/inspector/table').send(body));
    expect(table.markets).toEqual(['rainbow', 'any-pair']);
    expect(table.limits).toMatchObject({ minCents: 200, maxCents: 3_000, couponCapCents: 10_000 });

    await grantRole(env, f.clubId, f.bob.userId, 'inspector');
    const { table: t2 } = ok(await f.bob.post('/api/inspector/table').send({ ...body, name: 'Inspected' }));
    expect(t2.markets).toEqual(['rainbow', 'any-pair']);
    expect(t2.limits).toMatchObject({ minCents: 100, maxCents: 5_000, couponCapCents: 20_000 });
  });
});

describe('dealers and open / close flows', () => {
  it('lists dealers with their table here and busy elsewhere', async () => {
    const f = await openFloor(env);
    const other = await setupClub(env, { owner: 'owner2', players: [], pointsEach: 0, clubName: 'Other Club' });
    const idle = await env.login('ivy');
    const { addMember } = await import('../../test/fixtures.js');
    await addMember(env, f.owner, f.clubId, idle);
    await grantRole(env, f.clubId, idle.userId, 'dealer');
    await addMember(env, other.owner, other.clubId, idle);
    await grantRole(env, other.clubId, idle.userId, 'dealer');
    const { table: t2 } = ok(await other.owner.post('/api/inspector/table').set('X-Club-Id', other.clubId).send({ name: 'Away' }));
    await env.db.execute(`update club_tables set status = 'open', dealer_id = '${idle.userId}' where id = '${t2.id}'`);

    const { dealers } = ok(await f.owner.get('/api/inspector/dealers'));
    expect(dealers).toEqual([
      expect.objectContaining({ id: f.dealer.userId, assignedTable: 'Main', assignedTableId: f.tableId, busyElsewhere: false }),
      expect.objectContaining({ id: idle.userId, assignedTable: null, busyElsewhere: true }),
    ]);
  });

  it('previews a close with the refund per coupon', async () => {
    const f = await openFloor(env);
    ok(await f.alice.post('/api/player/coupon').send({ tableId: f.tableId, rounds: 3, selections: [{ market: 'rainbow', stakeCents: 100 }, { market: 'any-pair', stakeCents: 100 }] }));
    ok(await f.bob.post('/api/player/coupon').send(coupon(f.tableId, 'has-ace', 300, 2)));
    await playHand(f, ['Qc', '7h', '3s']);
    const p = ok(await f.owner.get(`/api/inspector/table/${f.tableId}/close-preview`));
    expect(p).toMatchObject({
      table: { id: f.tableId, kind: 'cash' }, hasActiveHand: false, couponCount: 2, playerCount: 2, totalRefundCents: 400 + 300,
    });
    expect(p.coupons).toEqual(expect.arrayContaining([
      expect.objectContaining({ player: 'alice', drawsLeft: 2, refundCents: 400 }),
      expect.objectContaining({ player: 'bob', drawsLeft: 1, refundCents: 300 }),
    ]));
  });

  it('opens with "Me — I will deal": the manager gets the dealer role and is seated', async () => {
    const f = await openFloor(env);
    await grantRole(env, f.clubId, f.bob.userId, 'manager');
    const { table } = ok(await f.owner.post('/api/inspector/table').send({ name: 'Two' }));
    await env.db.execute(`update clubs set level = 'club500' where id = '${f.clubId}'`);
    const res = ok(await f.bob.put(`/api/inspector/table/${table.id}/open`).send({ dealerId: f.bob.userId }));
    expect(res.table).toMatchObject({ status: 'open', dealerId: f.bob.userId });
    expect(env.events.named('club:context-changed').some((e) => e.room === `user:${f.bob.userId}`)).toBe(true);
  });

  it('stands the dealer up at their other table with leaveHeld', async () => {
    const f = await openFloor(env);
    const { table } = ok(await f.owner.post('/api/inspector/table').send({ name: 'Two' }));
    await env.db.execute(`update clubs set level = 'club500' where id = '${f.clubId}'`);
    const res = ok(await f.owner.put(`/api/inspector/table/${table.id}/open`).send({ dealerId: f.dealer.userId, leaveHeld: true }));
    expect(res.left).toEqual({ tableId: f.tableId, tableName: 'Main' });
    expect(res.table.dealerId).toBe(f.dealer.userId);
  });
});
