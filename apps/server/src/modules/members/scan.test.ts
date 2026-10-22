import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memberships } from '../../db/schema/index.js';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { grantRole, setupClub } from '../../test/fixtures.js';
import { issuePlayerCode, verifyPlayerCode } from './playerCode.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

const codeOf = async (a: Agent): Promise<string> => ok(await a.get('/api/clubs/player-code')).code;

describe('player code', () => {
  it('is a signed <userId>.<counter>.<signature> that rotates every minute', async () => {
    const player = await env.login('player');
    const first = ok(await player.get('/api/clubs/player-code'));
    expect(first.code).toMatch(new RegExp(`^${player.userId}\\.\\d{9,11}\\.[A-Za-z0-9_-]{22}$`));
    expect(first.rotatesInSeconds).toBeGreaterThan(0);
    expect(first.rotatesInSeconds).toBeLessThanOrEqual(60);
    expect(await codeOf(player)).toBe(first.code);
    env.clock.advance(60_000);
    expect(await codeOf(player)).not.toBe(first.code);
  });

  it('verifies signature, age and format', () => {
    const now = new Date('2026-09-24T18:00:30Z');
    const code = issuePlayerCode('3f1c2b9e-1111-4222-8333-444455556666', now);
    expect(verifyPlayerCode(code, now)).toBe('3f1c2b9e-1111-4222-8333-444455556666');
    expect(verifyPlayerCode(`https://app.example/#/pc/${code}`, now)).toBe('3f1c2b9e-1111-4222-8333-444455556666');
    expect(() => verifyPlayerCode(code, new Date(now.getTime() + 150_000))).toThrow('club.scan_code_expired');
    expect(() => verifyPlayerCode(`${code.slice(0, -2)}AA`, now)).toThrow('club.scan_code_invalid');
    const [, counter, sig] = code.split('.');
    expect(() => verifyPlayerCode(`3f1c2b9e-1111-4222-8333-444455556667.${counter}.${sig}`, now)).toThrow('club.scan_code_invalid');
    expect(() => verifyPlayerCode('hello', now)).toThrow('club.scan_code_invalid');
    expect(() => verifyPlayerCode('#/inspector/player/3f1c2b9e-1111-4222-8333-444455556666', now)).toThrow('club.scan_code_old');
  });
});

describe('desk scan', () => {
  async function desk() {
    const fx = await setupClub(env, { players: ['insp', 'member', 'dealer'], pointsEach: 0 });
    const [insp, member, dealer] = fx.players as [Agent, Agent, Agent];
    await grantRole(env, fx.clubId, insp.userId, 'inspector');
    await grantRole(env, fx.clubId, dealer.userId, 'dealer');
    return { ...fx, insp, member, dealer };
  }

  it('finds an active member', async () => {
    const { clubId, insp, member } = await desk();
    const res = ok(await insp.post(`/api/clubs/${clubId}/scan`).send({ code: await codeOf(member) }));
    expect(res).toMatchObject({ state: 'active', player: { id: member.userId, username: 'member', displayName: 'member' } });
  });

  it('only lets owner, manager and inspector scan', async () => {
    const { clubId, member, dealer } = await desk();
    const code = await codeOf(member);
    expect(errCode(await dealer.post(`/api/clubs/${clubId}/scan`).send({ code }))).toBe('club.scan_denied');
    expect(errCode(await member.post(`/api/clubs/${clubId}/scan`).send({ code }))).toBe('club.scan_denied');
    const outsider = await env.login('outsider');
    expect(errCode(await outsider.post(`/api/clubs/${clubId}/scan`).send({ code }))).toBe('club.scan_denied');
  });

  it('sends a join request for a newcomer, who is told', async () => {
    const { clubId, owner, insp } = await desk();
    const walkIn = await env.login('walkin');
    const code = await codeOf(walkIn);
    expect(ok(await insp.post(`/api/clubs/${clubId}/scan`).send({ code }))).toMatchObject({ state: 'none', player: { id: walkIn.userId } });
    ok(await insp.post(`/api/clubs/${clubId}/scan/request`).send({ code }));
    const [m] = await env.db.select().from(memberships).where(and(eq(memberships.clubId, clubId), eq(memberships.userId, walkIn.userId)));
    expect(m).toMatchObject({ status: 'pending', via: 'scan' });
    expect(ok(await insp.post(`/api/clubs/${clubId}/scan`).send({ code })).state).toBe('pending');
    expect(errCode(await insp.post(`/api/clubs/${clubId}/scan/request`).send({ code }))).toBe('club.request_pending');
    const { notices } = ok(await walkIn.get('/api/clubs/notices'));
    expect(notices[0]).toMatchObject({ code: 'club.scan_request', params: { club: 'Sharks Imperial' } });
    void owner;
  });

  it('asks before re-inviting a former member', async () => {
    const { clubId, owner, insp, member } = await desk();
    ok(await owner.post(`/api/clubs/${clubId}/members/${member.userId}/remove`).send({}));
    const code = await codeOf(member);
    const scanned = ok(await insp.post(`/api/clubs/${clubId}/scan`).send({ code }));
    expect(scanned.state).toBe('removed');
    expect(scanned.endedAt).toBeTruthy();
    expect(errCode(await insp.post(`/api/clubs/${clubId}/scan/request`).send({ code }))).toBe('club.scan_confirm_return');
    ok(await insp.post(`/api/clubs/${clubId}/scan/request`).send({ code, confirmReturn: true }));
  });

  it('refuses members and expired codes', async () => {
    const { clubId, insp, member } = await desk();
    const code = await codeOf(member);
    expect(errCode(await insp.post(`/api/clubs/${clubId}/scan/request`).send({ code }))).toBe('club.scan_already_member');
    env.clock.advance(3 * 60_000);
    expect(errCode(await insp.post(`/api/clubs/${clubId}/scan`).send({ code }))).toBe('club.scan_code_expired');
    expect(errCode(await insp.post(`/api/clubs/${clubId}/scan`).send({ code: 'nonsense' }))).toBe('club.scan_code_invalid');
  });
});
