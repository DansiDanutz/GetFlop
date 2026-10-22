import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, memberships } from '../../db/schema/index.js';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { grantRole, setupClub } from '../../test/fixtures.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

async function staffClub() {
  const fx = await setupClub(env, { players: ['mgr', 'insp', 'deal', 'pl'], pointsEach: 0 });
  const [mgr, insp, deal, pl] = fx.players as [Agent, Agent, Agent, Agent];
  await grantRole(env, fx.clubId, mgr.userId, 'manager');
  await grantRole(env, fx.clubId, insp.userId, 'inspector');
  await grantRole(env, fx.clubId, deal.userId, 'dealer');
  return { ...fx, mgr, insp, deal, pl };
}

const rolesOf = async (clubId: string, userId: string) => {
  const [m] = await env.db.select().from(memberships).where(and(eq(memberships.clubId, clubId), eq(memberships.userId, userId)));
  return m!.roles;
};

describe('role grant and revoke', () => {
  it('lets the owner grant and revoke manager, emits context-changed and audits', async () => {
    const { clubId, owner, pl } = await staffClub();
    env.events.clear();
    const res = ok(await owner.post(`/api/clubs/${clubId}/members/${pl.userId}/roles/manager`).send({}));
    expect(res.roles).toEqual(['manager']);
    expect(env.events.named('club:context-changed')).toEqual([
      { room: `user:${pl.userId}`, event: 'club:context-changed', payload: { clubId } },
    ]);
    ok(await owner.delete(`/api/clubs/${clubId}/members/${pl.userId}/roles/manager`));
    expect(await rolesOf(clubId, pl.userId)).toEqual([]);
    const audit = await env.db.select().from(auditLog).where(eq(auditLog.clubId, clubId));
    expect(audit.map((a) => a.action)).toEqual(['members.role_granted', 'members.role_revoked']);
  });

  it('keeps other roles when revoking one', async () => {
    const { clubId, owner, insp } = await staffClub();
    ok(await owner.post(`/api/clubs/${clubId}/members/${insp.userId}/roles/dealer`).send({}));
    ok(await owner.delete(`/api/clubs/${clubId}/members/${insp.userId}/roles/inspector`));
    expect(await rolesOf(clubId, insp.userId)).toEqual(['dealer']);
  });

  it('applies the manager rank rules', async () => {
    const { clubId, owner, mgr, insp, deal, pl } = await staffClub();
    const base = `/api/clubs/${clubId}/members`;
    expect(errCode(await mgr.post(`${base}/${pl.userId}/roles/manager`).send({}))).toBe('members.rank_too_high');
    ok(await mgr.post(`${base}/${pl.userId}/roles/inspector`).send({}));
    ok(await mgr.post(`${base}/${deal.userId}/roles/inspector`).send({}));
    ok(await mgr.delete(`${base}/${insp.userId}/roles/inspector`));
    expect(errCode(await mgr.post(`${base}/${owner.userId}/roles/dealer`).send({}))).toBe('members.target_outranks');
    ok(await owner.post(`${base}/${pl.userId}/roles/manager`).send({}));
    expect(errCode(await mgr.post(`${base}/${pl.userId}/roles/dealer`).send({}))).toBe('members.target_outranks');
  });

  it('allows only the dealer role on one\'s own card', async () => {
    const { clubId, owner, mgr } = await staffClub();
    const base = `/api/clubs/${clubId}/members`;
    ok(await owner.post(`${base}/${owner.userId}/roles/dealer`).send({}));
    expect(await rolesOf(clubId, owner.userId)).toEqual(['owner', 'dealer']);
    ok(await mgr.post(`${base}/${mgr.userId}/roles/dealer`).send({}));
    expect(errCode(await mgr.delete(`${base}/${mgr.userId}/roles/manager`))).toBe('members.self_change');
    expect(errCode(await owner.post(`${base}/${owner.userId}/roles/inspector`).send({}))).toBe('members.self_change');
  });

  it('refuses inspectors, dealers and players', async () => {
    const { clubId, insp, deal, pl } = await staffClub();
    for (const actor of [insp, deal]) {
      expect(errCode(await actor.post(`/api/clubs/${clubId}/members/${pl.userId}/roles/dealer`).send({}))).toBe('members.forbidden');
    }
    expect(errCode(await pl.post(`/api/clubs/${clubId}/members/${pl.userId}/roles/dealer`).send({}))).toBe('members.forbidden');
  });

  it('rejects unknown roles, owner changes and non-members', async () => {
    const { clubId, owner, pl } = await staffClub();
    const base = `/api/clubs/${clubId}/members`;
    expect(errCode(await owner.post(`${base}/${pl.userId}/roles/boss`).send({}))).toBe('members.role_unknown');
    expect(errCode(await owner.post(`${base}/${pl.userId}/roles/owner`).send({}))).toBe('members.owner_transfer_only');
    expect(errCode(await owner.delete(`${base}/${owner.userId}/roles/owner`))).toBe('members.owner_transfer_only');
    const stranger = await env.login('stranger');
    expect(errCode(await owner.post(`${base}/${stranger.userId}/roles/dealer`).send({}))).toBe('members.not_found');
  });

  it('keeps one owner even for a platform admin', async () => {
    const { clubId, owner, pl } = await staffClub();
    const admin = await env.login('root', { admin: true });
    const base = `/api/clubs/${clubId}/members`;
    expect(errCode(await admin.post(`${base}/${pl.userId}/roles/owner`).send({}))).toBe('members.one_owner');
    expect(errCode(await admin.delete(`${base}/${owner.userId}/roles/owner`))).toBe('members.last_owner');
    ok(await admin.post(`${base}/${owner.userId}/roles/manager`).send({}));
  });
});

describe('play mode', () => {
  it('sets watch-only, which blocks play, and back', async () => {
    const { clubId, owner, mgr, pl } = await staffClub();
    const url = `/api/clubs/${clubId}/members/${pl.userId}/play-mode`;
    expect(errCode(await owner.put(url).send({ mode: 'sleep' }))).toBe('members.play_mode_invalid');
    ok(await mgr.put(url).send({ mode: 'watch' }));
    expect(ok(await pl.get('/api/clubs/context')).playMode).toBe('watch');
    ok(await owner.put(url).send({ mode: 'play' }));
    expect(ok(await pl.get('/api/clubs/context')).playMode).toBe('play');
  });

  it('applies the rank rule', async () => {
    const { clubId, owner, mgr, insp, pl } = await staffClub();
    expect(errCode(await insp.put(`/api/clubs/${clubId}/members/${pl.userId}/play-mode`).send({ mode: 'watch' }))).toBe('members.forbidden');
    expect(errCode(await mgr.put(`/api/clubs/${clubId}/members/${owner.userId}/play-mode`).send({ mode: 'watch' }))).toBe('members.target_outranks');
    ok(await mgr.put(`/api/clubs/${clubId}/members/${mgr.userId}/play-mode`).send({ mode: 'watch' }));
  });
});
