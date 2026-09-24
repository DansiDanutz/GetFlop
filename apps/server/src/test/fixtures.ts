import type { Agent, TestEnv } from './harness.js';
import { ok } from './harness.js';

export interface ClubFixture {
  readonly clubId: string;
  readonly publicId: string;
  readonly owner: Agent;
  /** Approved members with an active club selected. */
  readonly players: Agent[];
}

/** Owner creates a club; each named player joins and is approved; the owner mints and sends Points. */
export async function setupClub(
  env: TestEnv,
  opts: { players?: string[]; pointsEach?: number; owner?: string; clubName?: string } = {},
): Promise<ClubFixture> {
  const owner = await env.login(opts.owner ?? 'owner');
  const { club } = ok(await owner.post('/api/clubs').send({ name: opts.clubName ?? 'Sharks Imperial', acceptClubTerms: true }));
  const players: Agent[] = [];
  for (const name of opts.players ?? ['player']) {
    const agent = await env.login(name);
    await addMember(env, owner, club.id, agent);
    players.push(agent);
  }
  const points = opts.pointsEach ?? 100;
  if (points > 0 && players.length > 0) {
    ok(await owner.post(`/api/clubs/${club.id}/points/mint`).send({ amount: points * players.length, reason: 'Opening' }));
    for (const p of players) {
      ok(await owner.post(`/api/inspector/player/${p.userId}/load`).set('X-Club-Id', club.id).send({ amount: points }));
    }
  }
  return { clubId: club.id, publicId: club.publicId, owner, players };
}

export async function addMember(env: TestEnv, staff: Agent, clubId: string, agent: Agent): Promise<void> {
  ok(await agent.post(`/api/clubs/${clubId}/join`).send({ source: 'club_id' }));
  const { requests } = ok(await staff.get(`/api/clubs/${clubId}/join-requests`));
  const mine = requests.find((r: { userId: string }) => r.userId === agent.userId);
  ok(await staff.post(`/api/clubs/${clubId}/join-requests/${mine.membershipId}/approve`).send({}));
  ok(await agent.post('/api/clubs/select').send({ clubId }));
}

/** Grants a role directly in the database (role management has its own tests). */
export async function grantRole(env: TestEnv, clubId: string, userId: string, role: 'manager' | 'inspector' | 'dealer'): Promise<void> {
  const { memberships } = await import('../db/schema/index.js');
  const { and, eq, sql } = await import('drizzle-orm');
  await env.db.update(memberships)
    .set({ roles: sql`array_append(${memberships.roles}, ${role})` })
    .where(and(eq(memberships.clubId, clubId), eq(memberships.userId, userId)));
}
