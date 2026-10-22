import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clubs, clubTables, ledgerEntries, memberships, pointRequests } from '../../db/schema/index.js';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { addMember, grantRole, setupClub } from '../../test/fixtures.js';
import { membershipGuards } from './hooks.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); membershipGuards.length = 0; });

const membership = async (clubId: string, userId: string) =>
  (await env.db.select().from(memberships).where(and(eq(memberships.clubId, clubId), eq(memberships.userId, userId))))[0]!;

describe('remove a member', () => {
  it('returns the whole balance to the pool, ends the membership and tells the member', async () => {
    const { clubId, owner, players: [pl] } = await setupClub(env, { pointsEach: 40 });
    ok(await pl!.post('/api/player/cashout-request').send({ amount: 5 }));
    env.events.clear();
    const res = ok(await owner.post(`/api/clubs/${clubId}/members/${pl!.userId}/remove`).send({ reason: 'Asked to leave' }));
    expect(res.returnedCents).toBe(4_000);
    const m = await membership(clubId, pl!.userId);
    expect(m).toMatchObject({ status: 'removed', roles: [], reviewedBy: owner.userId, rejectionReason: 'Asked to leave' });
    const [ended] = await env.db.select().from(ledgerEntries).where(eq(ledgerEntries.kind, 'membership_ended'));
    expect(ended).toMatchObject({ amountCents: 4_000, actorId: owner.userId, userId: pl!.userId });
    expect(ok(await owner.get(`/api/clubs/${clubId}/points`))).toMatchObject({ pool: 4_000, inWallets: 0, drift: 0 });
    expect(env.events.named('club:membership-changed')[0]).toMatchObject({
      room: `user:${pl!.userId}`, payload: { status: 'removed', clubId, clubName: 'Sharks Imperial' },
    });
    const [req] = await env.db.select().from(pointRequests);
    expect(req!.status).toBe('rejected');
    const { notices } = ok(await pl!.get('/api/clubs/notices'));
    expect(notices[0]).toMatchObject({ code: 'club.removed', params: { club: 'Sharks Imperial' } });
    expect(errCode(await pl!.get('/api/player/balance'))).not.toBe('status 200');
  });

  it('lets a removed member ask to join again', async () => {
    const { clubId, owner, players: [pl] } = await setupClub(env, { pointsEach: 0 });
    ok(await owner.put(`/api/clubs/${clubId}/members/${pl!.userId}/play-mode`).send({ mode: 'watch' }));
    ok(await owner.post(`/api/clubs/${clubId}/members/${pl!.userId}/remove`).send({}));
    await addMember(env, owner, clubId, pl!);
    expect((await membership(clubId, pl!.userId)).playMode).toBe('watch');
  });

  it('applies the rank rules', async () => {
    const { clubId, owner, players: [mgr, m2, insp] } = await setupClub(env, { players: ['mgr', 'm2', 'insp'], pointsEach: 0 });
    await grantRole(env, clubId, mgr!.userId, 'manager');
    await grantRole(env, clubId, m2!.userId, 'manager');
    await grantRole(env, clubId, insp!.userId, 'inspector');
    const url = (u: Agent) => `/api/clubs/${clubId}/members/${u.userId}/remove`;
    expect(errCode(await owner.post(url(owner)).send({}))).toBe('members.self_change');
    expect(errCode(await insp!.post(url(m2!)).send({}))).toBe('members.forbidden');
    expect(errCode(await mgr!.post(url(m2!)).send({}))).toBe('members.target_outranks');
    expect(errCode(await mgr!.post(url(owner)).send({}))).toBe('members.target_outranks');
    ok(await mgr!.post(url(insp!)).send({}));
    ok(await owner.post(url(m2!)).send({}));
    expect(errCode(await owner.post(url(m2!)).send({}))).toBe('members.not_found');
  });

  it('returns inspector stock to the pool', async () => {
    const { clubId, owner, players: [insp] } = await setupClub(env, { players: ['insp'], pointsEach: 0 });
    await grantRole(env, clubId, insp!.userId, 'inspector');
    ok(await owner.post(`/api/clubs/${clubId}/points/mint`).send({ amount: 30, reason: 'Float' }));
    ok(await owner.post(`/api/clubs/${clubId}/members/${insp!.userId}/stock`).send({ direction: 'give', amount: 20 }));
    ok(await owner.post(`/api/clubs/${clubId}/members/${insp!.userId}/remove`).send({}));
    expect(ok(await owner.get(`/api/clubs/${clubId}/points`))).toMatchObject({ pool: 3_000, inStocks: 0, drift: 0 });
  });
});

describe('leave a club', () => {
  it('returns the balance and marks the membership as left', async () => {
    const { clubId, owner, players: [pl] } = await setupClub(env, { pointsEach: 12 });
    const res = ok(await pl!.post(`/api/clubs/${clubId}/leave`).send({ reason: 'Moving away' }));
    expect(res.returnedCents).toBe(1_200);
    expect(await membership(clubId, pl!.userId)).toMatchObject({ status: 'left', reviewedBy: pl!.userId });
    expect(ok(await owner.get(`/api/clubs/${clubId}/points`))).toMatchObject({ pool: 1_200, drift: 0 });
    const { members } = ok(await owner.get(`/api/clubs/${clubId}/members?filter=ended`));
    expect(members[0]).toMatchObject({ userId: pl!.userId, status: 'left', endedBy: { userId: pl!.userId } });
  });

  it('blocks the owner', async () => {
    const { clubId, owner } = await setupClub(env, { players: [], pointsEach: 0 });
    expect(errCode(await owner.post(`/api/clubs/${clubId}/leave`).send({}))).toBe('club.leave_last_owner');
  });

  it('blocks a member with live coupons', async () => {
    const { clubId, owner, players: [pl] } = await setupClub(env, { pointsEach: 50 });
    const { table } = ok(await owner.post('/api/inspector/table').set('X-Club-Id', clubId).send({ name: 'T1' }));
    ok(await owner.put(`/api/inspector/table/${table.id}/open`).set('X-Club-Id', clubId).send({}));
    ok(await pl!.post('/api/player/coupon').send({ tableId: table.id, rounds: 3, selections: [{ market: 'rainbow', stakeCents: 100 }] }));
    const res = await pl!.post(`/api/clubs/${clubId}/leave`).send({});
    expect(errCode(res)).toBe('club.leave_live_coupons');
    expect(res.body.error.params).toEqual({ count: 1 });
  });

  it('blocks a member who is dealing', async () => {
    const { clubId, owner, players: [dl] } = await setupClub(env, { players: ['dl'], pointsEach: 0 });
    await grantRole(env, clubId, dl!.userId, 'dealer');
    const { table } = ok(await owner.post('/api/inspector/table').set('X-Club-Id', clubId).send({ name: 'Main' }));
    ok(await owner.put(`/api/inspector/table/${table.id}/open`).set('X-Club-Id', clubId).send({ dealerId: dl!.userId }));
    const res = await dl!.post(`/api/clubs/${clubId}/leave`).send({});
    expect(errCode(res)).toBe('club.leave_dealing');
    expect(res.body.error.params).toEqual({ table: 'Main' });
    await env.db.update(clubTables).set({ dealerId: null });
    ok(await dl!.post(`/api/clubs/${clubId}/leave`).send({}));
  });

  it('runs the blockers other modules register (tournaments)', async () => {
    const { clubId, players: [pl] } = await setupClub(env, { pointsEach: 0 });
    const { AppError } = await import('../../http/errors.js');
    membershipGuards.push(async () => { throw new AppError('club.leave_tournament', 409, { tournament: 'Friday Cup' }); });
    const res = await pl!.post(`/api/clubs/${clubId}/leave`).send({});
    expect(errCode(res)).toBe('club.leave_tournament');
  });

  it('refuses non-members', async () => {
    const { clubId } = await setupClub(env, { players: [], pointsEach: 0 });
    const stranger = await env.login('stranger');
    expect(errCode(await stranger.post(`/api/clubs/${clubId}/leave`).send({}))).toBe('club.access_denied');
  });
});

describe('transfer ownership', () => {
  it('moves the club to another member; the old owner becomes manager', async () => {
    const { clubId, owner, players: [heir] } = await setupClub(env, { players: ['heir'], pointsEach: 0 });
    await grantRole(env, clubId, heir!.userId, 'dealer');
    env.events.clear();
    ok(await owner.post(`/api/clubs/${clubId}/owner/transfer`).send({ userId: heir!.userId }));
    expect((await membership(clubId, heir!.userId)).roles).toEqual(['owner', 'dealer']);
    expect((await membership(clubId, owner.userId)).roles).toEqual(['manager']);
    const [club] = await env.db.select().from(clubs).where(eq(clubs.id, clubId));
    expect(club!.ownerId).toBe(heir!.userId);
    expect(env.events.named('club:context-changed').map((e) => e.room).sort())
      .toEqual([`user:${heir!.userId}`, `user:${owner.userId}`].sort());
    expect(errCode(await owner.post(`/api/clubs/${clubId}/owner/transfer`).send({ userId: heir!.userId }))).toBe('members.owner_only');
    ok(await heir!.post(`/api/clubs/${clubId}/owner/transfer`).send({ userId: owner.userId }));
    expect((await membership(clubId, owner.userId)).roles).toEqual(['owner']);
  });

  it('rejects self, non-members and non-owners', async () => {
    const { clubId, owner, players: [mgr] } = await setupClub(env, { players: ['mgr'], pointsEach: 0 });
    await grantRole(env, clubId, mgr!.userId, 'manager');
    const stranger = await env.login('stranger');
    const url = `/api/clubs/${clubId}/owner/transfer`;
    expect(errCode(await owner.post(url).send({ userId: owner.userId }))).toBe('members.owner_self');
    expect(errCode(await owner.post(url).send({ userId: stranger.userId }))).toBe('members.not_found');
    expect(errCode(await mgr!.post(url).send({ userId: mgr!.userId }))).toBe('members.owner_only');
  });
});
