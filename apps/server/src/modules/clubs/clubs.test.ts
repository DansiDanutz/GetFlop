import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clubs } from '../../db/schema/index.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { addMember, grantRole, setupClub } from '../../test/fixtures.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

describe('clubs', () => {
  it('creates a club with a 7-digit ID and makes the creator owner', async () => {
    const owner = await env.login('owner');
    expect(errCode(await owner.post('/api/clubs').send({ name: 'Sharks' }))).toBe('club.terms_required');
    expect(errCode(await owner.post('/api/clubs').send({ name: 'ab', acceptClubTerms: true }))).toBe('club.name_invalid');
    const { club } = ok(await owner.post('/api/clubs').send({ name: 'Sharks Imperial', acceptClubTerms: true }));
    expect(club.publicId).toMatch(/^\d{7}$/);
    const context = ok(await owner.get('/api/clubs/context'));
    expect(context.roles).toEqual(['owner']);
    expect(context.surfaces).toEqual(['player', 'inspector', 'club']);
    expect(context.capabilities).toContain('points.mint');
  });

  it('finds a club by ID and runs the join request flow', async () => {
    const owner = await env.login('owner');
    const { club } = ok(await owner.post('/api/clubs').send({ name: 'Sharks Imperial', acceptClubTerms: true }));
    const player = await env.login('player');
    expect(errCode(await player.get('/api/clubs/find/123'))).toBe('club.id_invalid');
    expect(errCode(await player.get('/api/clubs/find/0000000'))).toBe('club.not_found');
    expect(ok(await player.get(`/api/clubs/find/${club.publicId}`)).membershipStatus).toBeNull();
    ok(await player.post(`/api/clubs/${club.id}/join`).send({ source: 'club_id' }));
    expect(errCode(await player.post(`/api/clubs/${club.id}/join`).send({}))).toBe('club.request_pending');
    expect(errCode(await player.get(`/api/clubs/${club.id}/join-requests`))).toBe('club.access_denied');
    const { requests } = ok(await owner.get(`/api/clubs/${club.id}/join-requests`));
    expect(requests).toHaveLength(1);
    ok(await owner.post(`/api/clubs/${club.id}/join-requests/${requests[0].membershipId}/approve`).send({}));
    expect(errCode(await owner.post(`/api/clubs/${club.id}/join-requests/${requests[0].membershipId}/approve`).send({})))
      .toBe('club.request_not_found');
    expect(errCode(await player.post(`/api/clubs/${club.id}/join`).send({}))).toBe('club.already_member');
    const { clubs: mine } = ok(await player.get('/api/clubs/mine'));
    expect(mine[0]).toMatchObject({ name: 'Sharks Imperial', membershipStatus: 'active', memberCount: 2 });
    expect(env.events.named('club:membership-changed')[0]!.payload).toMatchObject({ status: 'active' });
  });

  it('enforces the Starter member capacity', async () => {
    const { clubId, owner } = await setupClub(env, { players: [], pointsEach: 0 });
    await env.db.update(clubs).set({ level: 'starter' });
    for (let i = 0; i < 29; i++) await addMember(env, owner, clubId, await env.login(`p${i}`));
    const late = await env.login('late');
    ok(await late.post(`/api/clubs/${clubId}/join`).send({}));
    const { requests } = ok(await owner.get(`/api/clubs/${clubId}/join-requests`));
    const res = await owner.post(`/api/clubs/${clubId}/join-requests/${requests[0].membershipId}/approve`).send({});
    expect(errCode(res)).toBe('commerce.capacity_members_billing');
    expect(res.body.error.params).toMatchObject({ used: 30, limit: 30, nextLevel: 'Club 100' });
  }, 60_000);

  it('lets an inspector review but not mint', async () => {
    const { clubId, owner, players } = await setupClub(env, { players: ['insp'], pointsEach: 0 });
    await grantRole(env, clubId, players[0]!.userId, 'inspector');
    expect(ok(await players[0]!.get('/api/clubs/context')).surfaces).toEqual(['player', 'inspector']);
    expect(errCode(await players[0]!.post(`/api/clubs/${clubId}/points/mint`).send({ amount: 5, reason: 'x' })))
      .toBe('points.mint_owner_only');
    ok(await owner.get(`/api/clubs/${clubId}/join-requests`));
  });
});
