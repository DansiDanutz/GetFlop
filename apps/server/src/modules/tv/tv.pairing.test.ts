import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { clubTables } from '../../db/schema/index.js';
import { grantRole, setupClub } from '../../test/fixtures.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { openCashTable, pairCash, tv } from './tv.fixtures.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('creating a pairing code (staff phone)', () => {
  it('returns a 6-digit code that expires in 10 minutes', async () => {
    const { owner, tableId } = await openCashTable(env);
    const res = ok(await owner.post('/api/tv/cash-pairings').send({ tableId }));
    expect(res.pairingCode).toMatch(/^\d{6}$/);
    expect(res.expiresInMinutes).toBe(10);
    expect(new Date(res.expiresAt).getTime()).toBe(env.clock.now().getTime() + 10 * MINUTE);
    expect(res.tvUrl).toBe('http://localhost:5173/#/tv/cash');
  });

  it('lets inspectors create codes but not players or dealers', async () => {
    const { clubId, owner, alice, dealer, tableId } = await openCashTable(env);
    expect(errCode(await alice.post('/api/tv/cash-pairings').send({ tableId }))).toBe('club.capability_missing');
    expect(errCode(await dealer.post('/api/tv/cash-pairings').send({ tableId }))).toBe('club.capability_missing');
    await grantRole(env, clubId, alice.userId, 'inspector');
    expect(ok(await alice.post('/api/tv/cash-pairings').send({ tableId })).pairingCode).toMatch(/^\d{6}$/);
    expect(owner).toBeDefined();
  });

  it('refuses unknown, closed and tournament tables', async () => {
    const { owner, tableId } = await openCashTable(env);
    expect(errCode(await owner.post('/api/tv/cash-pairings').send({ tableId: 'nope' }))).toBe('tv.table_not_found');
    const { table: closed } = ok(await owner.post('/api/inspector/table').send({ name: 'Table 2' }));
    expect(errCode(await owner.post('/api/tv/cash-pairings').send({ tableId: closed.id }))).toBe('tv.table_closed');
    await env.db.update(clubTables).set({ kind: 'tournament' }).where(eq(clubTables.id, tableId));
    expect(errCode(await owner.post('/api/tv/cash-pairings').send({ tableId }))).toBe('tv.cash_only');
  });

  it('refuses a table of another club than the selected one', async () => {
    const { tableId } = await openCashTable(env);
    const other = await setupClub(env, { owner: 'owner2', clubName: 'Other Club', players: [] });
    const res = await other.owner.post('/api/tv/cash-pairings').set('X-Club-Id', other.clubId).send({ tableId });
    expect(errCode(res)).toBe('tv.club_mismatch');
  });

  it('validates the body', async () => {
    const { owner } = await openCashTable(env);
    expect(errCode(await owner.post('/api/tv/cash-pairings').send({}))).toBe('validation.invalid');
  });
});

describe('claiming a code (TV)', () => {
  it('pairs an anonymous TV and tells the staff room', async () => {
    const { clubId, owner, tableId } = await openCashTable(env);
    const { pairingCode } = ok(await owner.post('/api/tv/cash-pairings').send({ tableId }));
    const claim = ok(await tv(env).post('/api/tv/cash-pairings/claim').send({ code: pairingCode }));
    expect(claim.tableName).toBe('Table 1');
    expect(claim.displayToken).toEqual(expect.any(String));
    expect(claim.displayToken.length).toBeGreaterThanOrEqual(32);
    const connected = env.events.named('tv:connected').at(-1)!;
    expect(connected.room).toBe(`staff:${clubId}`);
    expect(connected.payload).toMatchObject({ kind: 'cash', targetId: tableId, name: 'Table 1' });
  });

  it('accepts a code typed with a space ("123 456")', async () => {
    const { owner, tableId } = await openCashTable(env);
    const { pairingCode } = ok(await owner.post('/api/tv/cash-pairings').send({ tableId }));
    const spaced = `${pairingCode.slice(0, 3)} ${pairingCode.slice(3)}`;
    expect(ok(await tv(env).post('/api/tv/cash-pairings/claim').send({ code: spaced })).tableName).toBe('Table 1');
  });

  it('is single use', async () => {
    const { owner, tableId } = await openCashTable(env);
    const { pairingCode } = ok(await owner.post('/api/tv/cash-pairings').send({ tableId }));
    ok(await tv(env).post('/api/tv/cash-pairings/claim').send({ code: pairingCode }));
    expect(errCode(await tv(env).post('/api/tv/cash-pairings/claim').send({ code: pairingCode }))).toBe('tv.pairing_code_invalid');
  });

  it('rejects malformed and unknown codes', async () => {
    await openCashTable(env);
    expect(errCode(await tv(env).post('/api/tv/cash-pairings/claim').send({ code: '12a456' }))).toBe('tv.pairing_code_invalid');
    expect(errCode(await tv(env).post('/api/tv/cash-pairings/claim').send({ code: 123456 }))).toBe('tv.pairing_code_invalid');
    const unknown = await tv(env).post('/api/tv/cash-pairings/claim').send({ code: '000000' });
    expect(errCode(unknown)).toBe('tv.pairing_code_invalid');
  });

  it('expires after 10 minutes', async () => {
    const { owner, tableId } = await openCashTable(env);
    const { pairingCode } = ok(await owner.post('/api/tv/cash-pairings').send({ tableId }));
    env.clock.advance(10 * MINUTE + 1_000);
    expect(errCode(await tv(env).post('/api/tv/cash-pairings/claim').send({ code: pairingCode }))).toBe('tv.pairing_expired');
  });

  it('a refreshed code replaces the previous one', async () => {
    const { owner, tableId } = await openCashTable(env);
    const first = ok(await owner.post('/api/tv/cash-pairings').send({ tableId })).pairingCode;
    const second = ok(await owner.post('/api/tv/cash-pairings').send({ tableId })).pairingCode;
    if (first !== second) {
      expect(errCode(await tv(env).post('/api/tv/cash-pairings/claim').send({ code: first }))).toBe('tv.pairing_expired');
    }
    ok(await tv(env).post('/api/tv/cash-pairings/claim').send({ code: second }));
  });

  it('a Ring Game code cannot be claimed as a tournament TV', async () => {
    const { owner, tableId } = await openCashTable(env);
    const { pairingCode } = ok(await owner.post('/api/tv/cash-pairings').send({ tableId }));
    const res = await tv(env).post('/api/tv/tournament-pairings/claim').send({ code: pairingCode });
    expect(errCode(res)).toBe('tv.pairing_code_invalid');
  });

  it('rate-limits repeated failed attempts from one address', async () => {
    const { owner, tableId } = await openCashTable(env);
    const { pairingCode } = ok(await owner.post('/api/tv/cash-pairings').send({ tableId }));
    const wrong = pairingCode === '999999' ? '999998' : '999999';
    for (let i = 0; i < 10; i += 1) {
      expect(errCode(await tv(env).post('/api/tv/cash-pairings/claim').send({ code: wrong }))).toBe('tv.pairing_code_invalid');
    }
    const blocked = await tv(env).post('/api/tv/cash-pairings/claim').send({ code: pairingCode });
    expect(blocked.status).toBe(429);
    expect(errCode(blocked)).toBe('tv.pairing_rate_limited');
    env.clock.advance(5 * MINUTE + 1_000);
    ok(await tv(env).post('/api/tv/cash-pairings/claim').send({ code: pairingCode }));
  });
});

describe('display sessions', () => {
  it('a paired TV plays for 24 hours, then gets 410', async () => {
    const { owner, tableId } = await openCashTable(env);
    const token = await pairCash(env, owner, tableId);
    ok(await tv(env).get(`/api/tv/cash/${token}`));
    env.clock.advance(24 * HOUR - 1_000);
    ok(await tv(env).get(`/api/tv/cash/${token}`));
    env.clock.advance(2_000);
    const res = await tv(env).get(`/api/tv/cash/${token}`);
    expect(res.status).toBe(410);
    expect(errCode(res)).toBe('tv.display_expired');
  });

  it('unknown tokens and the wrong display kind get 410', async () => {
    const { owner, tableId } = await openCashTable(env);
    expect((await tv(env).get('/api/tv/cash/not-a-token')).status).toBe(410);
    const token = await pairCash(env, owner, tableId);
    expect((await tv(env).get(`/api/tv/tournament/${token}`)).status).toBe(410);
  });

  it('a new direct link disables the previous one', async () => {
    const { owner, tableId } = await openCashTable(env);
    const first = ok(await owner.post('/api/tv/cash-sessions').send({ tableId }));
    expect(first.tvPath).toBe(`/tv/cash/${first.token}`);
    expect(new Date(first.expiresAt).getTime()).toBe(env.clock.now().getTime() + 24 * HOUR);
    ok(await tv(env).get(`/api/tv/cash/${first.token}`));
    const second = ok(await owner.post('/api/tv/cash-sessions').send({ tableId }));
    expect((await tv(env).get(`/api/tv/cash/${first.token}`)).status).toBe(410);
    ok(await tv(env).get(`/api/tv/cash/${second.token}`));
  });

  it('staff list and revoke the TVs of a table', async () => {
    const { owner, alice, tableId } = await openCashTable(env);
    const paired = await pairCash(env, owner, tableId);
    ok(await owner.post('/api/tv/cash-sessions').send({ tableId }));
    const { sessions } = ok(await owner.get(`/api/tv/sessions?kind=cash&targetId=${tableId}`));
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s: { via: string }) => s.via).sort()).toEqual(['link', 'pairing']);
    expect(JSON.stringify(sessions)).not.toContain(paired);

    expect(errCode(await alice.get(`/api/tv/sessions?kind=cash&targetId=${tableId}`))).toBe('club.capability_missing');
    const target = sessions.find((s: { via: string }) => s.via === 'pairing');
    expect(errCode(await alice.delete(`/api/tv/sessions/${target.id}`))).toBe('club.capability_missing');

    ok(await owner.delete(`/api/tv/sessions/${target.id}`));
    expect((await tv(env).get(`/api/tv/cash/${paired}`)).status).toBe(410);
    expect(env.events.named('tv:revoked').at(-1)!.room).toBe(`tv:${target.id}`);
    expect(ok(await owner.get(`/api/tv/sessions?kind=cash&targetId=${tableId}`)).sessions).toHaveLength(1);
    expect(errCode(await owner.delete('/api/tv/sessions/missing'))).toBe('tv.session_not_found');
  });

  it('staff endpoints need a signed-in user', async () => {
    const { tableId } = await openCashTable(env);
    expect(errCode(await tv(env).post('/api/tv/cash-pairings').send({ tableId }))).toBe('auth.required');
    expect(errCode(await tv(env).post('/api/tv/cash-sessions').send({ tableId }))).toBe('auth.required');
  });
});
