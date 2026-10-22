import request from 'supertest';
import { grantRole, setupClub } from '../../test/fixtures.js';
import { ok, type Agent, type TestEnv } from '../../test/harness.js';

export interface TvSetup {
  readonly clubId: string;
  readonly owner: Agent;
  readonly dealer: Agent;
  readonly alice: Agent;
  readonly bob: Agent;
  readonly tableId: string;
  readonly joinCode: string;
}

/** A club with an open Ring Game table ("Table 1") and a seated dealer; Alice and Bob hold 100 PTS each. */
export async function openCashTable(env: TestEnv): Promise<TvSetup> {
  const { clubId, owner, players: [dealer, alice, bob] } = await setupClub(env, { players: ['dealer', 'alice', 'bob'], pointsEach: 100 });
  await grantRole(env, clubId, dealer!.userId, 'dealer');
  const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'Table 1', game: 'nlh' }));
  ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({ dealerId: dealer!.userId }));
  return { clubId, owner, dealer: dealer!, alice: alice!, bob: bob!, tableId: table.id, joinCode: table.joinCode };
}

/** An anonymous client (the TV has no user session). */
export const tv = (env: TestEnv) => request(env.url);

/** Staff creates a code and an anonymous TV claims it. Returns the display token. */
export async function pairCash(env: TestEnv, staff: Agent, tableId: string): Promise<string> {
  const { pairingCode } = ok(await staff.post('/api/tv/cash-pairings').send({ tableId }));
  return ok(await tv(env).post('/api/tv/cash-pairings/claim').send({ code: pairingCode })).displayToken as string;
}

export const pick = (tableId: string, markets: string[], stakeCents: number, rounds = 1) =>
  ({ tableId, rounds, selections: markets.map((market) => ({ market, stakeCents })) });
