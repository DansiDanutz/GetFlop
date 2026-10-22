import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clubTables, clubs, ledgerEntries, memberships, sessionRevocations, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { grantRole, setupClub } from '../../test/fixtures.js';
import { membershipGuards, type MembershipGuard } from '../members/hooks.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv({ bettingTimerSeconds: 0 }); });
afterEach(async () => { await env.close(); });

const userRow = async (id: string) => (await env.db.select().from(users).where(eq(users.id, id)))[0]!;

describe('POST /auth/delete-account', () => {
  it('rejects a wrong PIN and deletes nothing', async () => {
    const nick = await env.login('nick');
    const res = await nick.post('/api/auth/delete-account').send({ pin: '9999' });
    expect(errCode(res)).toBe('account.pin_wrong');
    expect(res.status).toBe(403);
    expect(ok(await nick.get('/api/auth/me')).user.username).toBe('nick');
  });

  it('never deletes a platform admin from the app', async () => {
    const admin = await env.login('root', { admin: true });
    expect(errCode(await admin.post('/api/auth/delete-account').send({ pin: '1234' }))).toBe('account.platform_admin');
  });

  it('blocks an owner whose club has other members, naming the club', async () => {
    const { owner } = await setupClub(env, { players: ['alice'] });
    const res = await owner.post('/api/auth/delete-account').send({ pin: '1234' });
    expect(errCode(res)).toBe('account.last_owner');
    expect(res.body.error.params).toEqual({ club: 'Sharks Imperial' });
  });

  it('returns balances to the pool, ends memberships, anonymizes and signs out everywhere', async () => {
    const { clubId, owner, players: [alice] } = await setupClub(env, { players: ['alice'], pointsEach: 25 });
    ok(await alice!.post('/api/player/reload-request').send({ amountCents: 500 }));
    const before = await userRow(alice!.userId);

    ok(await alice!.post('/api/auth/delete-account').send({ pin: '1234' }));

    const [ended] = await env.db.select().from(ledgerEntries)
      .where(and(eq(ledgerEntries.clubId, clubId), eq(ledgerEntries.kind, 'membership_ended')));
    expect(ended).toMatchObject({ amountCents: 2_500, userId: alice!.userId, actorId: alice!.userId });
    expect(ok(await owner.get(`/api/clubs/${clubId}/points`))).toMatchObject({ pool: 2_500, inWallets: 0, drift: 0 });
    const [m] = await env.db.select().from(memberships).where(eq(memberships.userId, alice!.userId));
    expect(m).toMatchObject({ status: 'left', roles: [] });
    expect(ok(await owner.get('/api/inspector/requests')).reloads).toEqual([]);

    const after = await userRow(alice!.userId);
    expect(after.username).not.toBe(before.username);
    expect(after).toMatchObject({ email: null, displayName: null, googleSub: null, isActive: false, activeClubId: null });
    expect(after.deletedAt).not.toBeNull();
    expect(after.pinHash).not.toBe(before.pinHash);

    // This device's cookie is cleared; any other device learns why from the revocation record.
    expect(errCode(await alice!.get('/api/auth/me'))).toBe('auth.required');
    const revoked = await env.db.select().from(sessionRevocations).where(eq(sessionRevocations.userId, alice!.userId));
    expect(revoked.map((r) => r.reason)).toEqual(['account_deleted']);
    expect(env.events.named('session:ended').at(-1)).toMatchObject({ room: `user:${alice!.userId}`, payload: { reason: 'account_deleted' } });
    expect(errCode(await request(env.url).post('/api/auth/login').send({ username: 'alice', pin: '1234' }))).toBe('auth.pin_wrong');
  });

  it('frees the username and email for a new account', async () => {
    const nick = await env.login('nick');
    ok(await nick.post('/api/auth/delete-account').send({ pin: '1234' }));
    const form = { username: 'nick', displayName: 'Nick', pin: '4321', email: 'nick@example.test', adult: true, acceptTerms: true };
    ok(await request(env.url).post('/api/auth/register/code').send(form));
  });

  it('closes a club whose owner is its only member', async () => {
    const { clubId, owner } = await setupClub(env, { players: [], pointsEach: 0 });
    const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'Table 1' }));
    ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({}));
    ok(await owner.post('/api/auth/delete-account').send({ pin: '1234' }));
    const [club] = await env.db.select().from(clubs).where(eq(clubs.id, clubId));
    expect(club!.status).toBe('deleted');
    const [t] = await env.db.select().from(clubTables).where(eq(clubTables.id, table.id));
    expect(t!.status).toBe('closed');
  });

  it('is blocked by live coupons and by dealing a table', async () => {
    const { clubId, owner, players: [dealer, alice] } = await setupClub(env, { players: ['dealer', 'alice'], pointsEach: 10 });
    await grantRole(env, clubId, dealer!.userId, 'dealer');
    const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'Table 1' }));
    ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({ dealerId: dealer!.userId }));
    ok(await alice!.post('/api/player/coupon').send({ tableId: table.id, rounds: 2, selections: [{ market: 'rainbow', stakeCents: 100 }] }));

    const live = await alice!.post('/api/auth/delete-account').send({ pin: '1234' });
    expect(errCode(live)).toBe('club.leave_live_coupons');
    expect(live.body.error.params).toEqual({ count: 1 });

    const dealing = await dealer!.post('/api/auth/delete-account').send({ pin: '1234' });
    expect(errCode(dealing)).toBe('club.leave_dealing');
    expect(dealing.body.error.params).toEqual({ table: 'Table 1' });
  });
  it('runs other modules\' leave blockers and rolls everything back', async () => {
    const { clubId, owner, players: [alice] } = await setupClub(env, { players: ['alice'], pointsEach: 5 });
    const guard: MembershipGuard = async () => { throw new AppError('club.leave_tournament', 409, { tournament: 'Friday' }); };
    membershipGuards.push(guard);
    try {
      const res = await alice!.post('/api/auth/delete-account').send({ pin: '1234' });
      expect(errCode(res)).toBe('club.leave_tournament');
    } finally {
      membershipGuards.splice(membershipGuards.indexOf(guard), 1);
    }
    expect(ok(await alice!.get('/api/auth/me')).user.username).toBe('alice');
    expect(ok(await owner.get(`/api/clubs/${clubId}/points`))).toMatchObject({ inWallets: 500, drift: 0 });
  });
});

describe('ended sessions', () => {
  it('tells a replaced device why and which device took over', async () => {
    const first = await env.login('nick');
    const second = await env.login('nick');
    const res = await first.get('/api/auth/me').set('User-Agent', 'x');
    expect(res.status).toBe(401);
    expect(errCode(res)).toBe('auth.session_ended');
    expect(res.body.error.params).toMatchObject({ reason: 'other_device' });
    ok(await second.get('/api/auth/me'));
  });

  it('names the new device from its user agent', async () => {
    const first = await env.login('nick');
    ok(await request(env.url).post('/api/auth/login')
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)').send({ username: 'nick', pin: '1234' }));
    expect((await first.get('/api/auth/me')).body.error.params).toEqual({ reason: 'other_device', deviceLabel: 'iphone' });
    expect(env.events.named('session:ended').at(-1)!.payload).toEqual({ reason: 'other_device', deviceLabel: 'iphone' });
  });

  it('signs out other devices on PIN change with reason pin_change, keeping this one', async () => {
    const here = await env.login('nick');
    ok(await here.post('/api/auth/pin/change').send({ pin: '1234', newPin: '5555' }));
    ok(await here.get('/api/auth/me'));
    expect(env.events.named('session:ended').at(-1)!.payload).toEqual({ reason: 'pin_change' });
  });

  it('returns 403 (not 401) for a wrong current PIN so the device stays signed in', async () => {
    const nick = await env.login('nick');
    const res = await nick.post('/api/auth/pin/change').send({ pin: '0000', newPin: '5555' });
    expect(res.status).toBe(403);
    expect(errCode(res)).toBe('auth.pin_wrong');
  });

  it('reports an expired session', async () => {
    const nick = await env.login('nick');
    env.clock.advance(31 * 86_400_000);
    expect(errCode(await nick.get('/api/auth/me'))).toBe('session.expired');
  });
});
