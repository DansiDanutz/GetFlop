import { eq } from 'drizzle-orm';
import { clubs, clubTables } from '../../db/schema/index.js';
import { addMember, grantRole, setupClub } from '../../test/fixtures.js';
import { ok, type Agent, type TestEnv } from '../../test/harness.js';

/** A club with a dealer, a player (alice), an inspector (floor) and open tables without a dealer. */
export interface DealerWorld {
  readonly clubId: string;
  readonly owner: Agent;
  readonly dealer: Agent;
  readonly alice: Agent;
  readonly floor: Agent;
  readonly tables: readonly string[];
}

const BIG_LEVEL = 'club5k';

async function openTables(owner: Agent, clubId: string, names: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const { table } = ok(await owner.post('/api/inspector/table').set('X-Club-Id', clubId).send({ name }));
    ok(await owner.put(`/api/inspector/table/${table.id}/open`).set('X-Club-Id', clubId).send({}));
    ids.push(table.id);
  }
  return ids;
}

export async function dealerWorld(env: TestEnv, opts: { tables?: number; approval?: boolean } = {}): Promise<DealerWorld> {
  const { clubId, owner, players } = await setupClub(env, { players: ['dealer', 'alice', 'floor'], pointsEach: 100 });
  const [dealer, alice, floor] = players as [Agent, Agent, Agent];
  await grantRole(env, clubId, dealer.userId, 'dealer');
  await grantRole(env, clubId, floor.userId, 'inspector');
  await env.db.update(clubs).set({ level: BIG_LEVEL, dealerSitApproval: Boolean(opts.approval) }).where(eq(clubs.id, clubId));
  const names = Array.from({ length: opts.tables ?? 2 }, (_, i) => `Table ${i + 1}`);
  const tables = await openTables(owner, clubId, names);
  return { clubId, owner, dealer, alice, floor, tables };
}

/** A second club ("Riverside") where `dealer` is also a dealer, with one open table. The dealer's active club is restored. */
export async function secondClub(env: TestEnv, dealer: Agent, restoreClubId: string, opts: { approval?: boolean } = {}) {
  const owner = await env.login('owner2');
  const { club } = ok(await owner.post('/api/clubs').send({ name: 'Riverside', acceptClubTerms: true }));
  await addMember(env, owner, club.id, dealer);
  await grantRole(env, club.id, dealer.userId, 'dealer');
  await env.db.update(clubs).set({ level: BIG_LEVEL, dealerSitApproval: Boolean(opts.approval) }).where(eq(clubs.id, club.id));
  const [tableId] = await openTables(owner, club.id, ['River 1']);
  ok(await dealer.post('/api/clubs/select').send({ clubId: restoreClubId }));
  return { clubId: club.id as string, owner, tableId: tableId! };
}

export async function makeAutoDeal(env: TestEnv, tableId: string): Promise<void> {
  await env.db.update(clubTables).set({ isAutoDeal: true }).where(eq(clubTables.id, tableId));
}
