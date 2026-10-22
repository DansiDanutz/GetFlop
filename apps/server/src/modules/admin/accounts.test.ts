import request from 'supertest';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, sessions, users } from '../../db/schema/index.js';
import { setupClub } from '../../test/fixtures.js';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';

let env: TestEnv;
let admin: Agent;
beforeEach(async () => {
  env = await createTestEnv();
  admin = await env.login('boss', { admin: true });
});
afterEach(async () => { await env.close(); });

const auditActions = async () => (await env.db.select().from(auditLog)).map((a) => a.action);

describe('accounts list', () => {
  it('filters admins, bots and deactivated accounts, with counts', async () => {
    await setupClub(env, { players: ['alice', 'bob'] });
    await env.db.update(users).set({ isBot: true }).where(eq(users.username, 'bob'));
    const all = ok(await admin.get('/api/admin/accounts'));
    expect(all.counts).toEqual({ all: 4, players: 2, admins: 1, inactive: 0, bots: 1 });
    expect(all.total).toBe(4);
    const alice = all.accounts.find((a: { username: string }) => a.username === 'alice');
    expect(alice).toMatchObject({ role: 'player', isActive: true, clubs: [{ name: 'Sharks Imperial' }] });

    expect(ok(await admin.get('/api/admin/accounts?filter=admins')).accounts.map((a: { username: string }) => a.username)).toEqual(['boss']);
    expect(ok(await admin.get('/api/admin/accounts?filter=bots')).accounts.map((a: { role: string }) => a.role)).toEqual(['bot']);
    expect(ok(await admin.get('/api/admin/accounts?filter=players')).total).toBe(2);
    expect(ok(await admin.get('/api/admin/accounts?q=ALI')).accounts.map((a: { username: string }) => a.username)).toEqual(['alice']);
    expect(ok(await admin.get('/api/admin/accounts?q=alice@example')).total).toBe(1);
    const page = ok(await admin.get('/api/admin/accounts?limit=2&offset=2'));
    expect(page.accounts).toHaveLength(2);
    expect(page.total).toBe(4);
  });

  it('rejects an unknown filter', async () => {
    expect(errCode(await admin.get('/api/admin/accounts?filter=nope'))).toBe('validation.invalid');
  });
});

describe('create and edit accounts', () => {
  it('creates a player who can sign in, and audits it', async () => {
    const { user } = ok(await admin.post('/api/admin/users').send({ username: 'carol', displayName: 'Carol', role: 'player', pin: '4321' }));
    expect(user).toMatchObject({ username: 'carol', displayName: 'Carol', role: 'player', isActive: true });
    const res = await request(env.url).post('/api/auth/login').send({ username: 'carol', pin: '4321' });
    expect(res.status).toBe(200);
    expect(await auditActions()).toContain('create_user');
  });

  it('creates an admin', async () => {
    const { user } = ok(await admin.post('/api/admin/users').send({ username: 'boss2', displayName: 'Boss 2', role: 'admin', pin: '123456' }));
    expect(user.role).toBe('admin');
  });

  it('validates the create form with the admin error codes', async () => {
    const post = (body: Record<string, unknown>) => admin.post('/api/admin/users').send(body);
    const base = { username: 'dave', displayName: 'Dave', role: 'player', pin: '1234' };
    expect(errCode(await post({ displayName: 'x', role: 'player' }))).toBe('admin.create_missing');
    expect(errCode(await post({ ...base, role: 'owner' }))).toBe('admin.role_invalid');
    expect(errCode(await post({ ...base, pin: '12' }))).toBe('admin.pin_digits');
    expect(errCode(await post({ ...base, pin: '123456789' }))).toBe('admin.pin_digits');
    expect(errCode(await post({ ...base, displayName: '' }))).toBe('admin.name_length');
    expect(errCode(await post({ ...base, displayName: 'x'.repeat(31) }))).toBe('admin.name_length');
    expect(errCode(await post({ ...base, username: 'a b' }))).toBe('user.username_invalid');
    expect(errCode(await post({ ...base, username: 'BOSS' }))).toBe('admin.username_taken');
  });

  it('edits the username and display name', async () => {
    const alice = await env.login('alice');
    const { user } = ok(await admin.put(`/api/admin/users/${alice.userId}`).send({ username: 'alice2', displayName: 'Alice Two' }));
    expect(user).toMatchObject({ username: 'alice2', displayName: 'Alice Two' });
    expect(ok(await admin.get(`/api/admin/users/${alice.userId}`)).user.username).toBe('alice2');
    expect(errCode(await admin.put(`/api/admin/users/${alice.userId}`).send({ username: 'boss' }))).toBe('admin.username_taken');
    expect(errCode(await admin.put('/api/admin/users/missing').send({ displayName: 'X' }))).toBe('admin.user_not_found');
    expect(await auditActions()).toContain('update_user');
  });

  it('keeps the legacy user list', async () => {
    await env.login('alice');
    const { users: list } = ok(await admin.get('/api/admin/users'));
    expect(list.map((u: { username: string }) => u.username).sort()).toEqual(['alice', 'boss']);
  });
});

describe('deactivate, reactivate and reset PIN', () => {
  it('signs the user out at once and blocks sign-in, then lets them back', async () => {
    const alice = await env.login('alice');
    expect((await alice.get('/api/auth/me')).status).toBe(200);
    const { user } = ok(await admin.put(`/api/admin/users/${alice.userId}/toggle-active`).send({ active: false }));
    expect(user.isActive).toBe(false);
    expect(await env.db.select().from(sessions).where(eq(sessions.userId, alice.userId))).toHaveLength(0);
    expect(errCode(await alice.get('/api/auth/me'))).toBe('auth.required');
    expect(env.events.named('session:ended').at(-1)).toMatchObject({ room: `user:${alice.userId}`, payload: { reason: 'deactivated' } });
    const login = await request(env.url).post('/api/auth/login').send({ username: 'alice', pin: '1234' });
    expect(errCode(login)).toBe('auth.account_inactive');

    ok(await admin.put(`/api/admin/users/${alice.userId}/toggle-active`).send({ active: true }));
    expect((await request(env.url).post('/api/auth/login').send({ username: 'alice', pin: '1234' })).status).toBe(200);
    expect(await auditActions()).toEqual(expect.arrayContaining(['deactivate_user', 'activate_user']));
  });

  it('never lets an admin deactivate themselves', async () => {
    expect(errCode(await admin.put(`/api/admin/users/${admin.userId}/toggle-active`).send({ active: false }))).toBe('admin.self_deactivate');
    expect(errCode(await admin.put('/api/admin/users/missing/toggle-active').send({ active: false }))).toBe('admin.user_not_found');
  });

  it('resets the PIN without closing the current sign-in', async () => {
    const alice = await env.login('alice');
    ok(await admin.put(`/api/admin/users/${alice.userId}/reset-pin`).send({ newPin: '8888' }));
    expect((await alice.get('/api/auth/me')).status).toBe(200);
    expect((await request(env.url).post('/api/auth/login').send({ username: 'alice', pin: '8888' })).status).toBe(200);
    expect(errCode(await admin.put(`/api/admin/users/${alice.userId}/reset-pin`).send({ newPin: 'abcd' }))).toBe('admin.pin_digits');
    expect(await auditActions()).toContain('reset_pin');
    const [entry] = await env.db.select().from(auditLog).where(eq(auditLog.action, 'reset_pin'));
    expect(JSON.stringify(entry!.data)).not.toContain('8888');
  });
});

describe('account detail', () => {
  it('shows clubs, movements with balance after, and devices', async () => {
    const { players: [alice] } = await setupClub(env, { players: ['alice'], pointsEach: 50 });
    const detail = ok(await admin.get(`/api/admin/players/${alice!.userId}/detail`));
    expect(detail.account).toMatchObject({ username: 'alice', role: 'player', signsInWith: ['pin'], email: 'alice@example.test' });
    expect(detail.clubs).toEqual([expect.objectContaining({ name: 'Sharks Imperial', status: 'active', hands: 0, balanceCents: 5_000 })]);
    expect(detail.movements[0]).toMatchObject({ kind: 'deposit', amountCents: 5_000, balanceAfterCents: 5_000, clubName: 'Sharks Imperial' });
    expect(detail.picks).toEqual({ total: 0, items: [] });
    expect(detail.devices.length).toBeGreaterThan(0);

    const summary = ok(await admin.get(`/api/admin/account/${alice!.userId}`));
    expect(summary.account.username).toBe('alice');
    expect(summary.clubs).toHaveLength(1);
    expect(errCode(await admin.get('/api/admin/players/missing/detail'))).toBe('admin.user_not_found');
  });
});
