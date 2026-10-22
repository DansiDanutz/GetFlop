import { eq } from 'drizzle-orm';
import { clubs } from '../../db/schema/index.js';
import { ok, type Agent, type TestEnv } from '../../test/harness.js';
import { grantRole, setupClub } from '../../test/fixtures.js';

export interface Floor {
  clubId: string;
  owner: Agent;
  dealer: Agent;
  alice: Agent;
  bob: Agent;
  tableId: string;
}

/** Club with a dealer, two players (100 PTS each) and one open table with the dealer seated. */
export async function openFloor(env: TestEnv): Promise<Floor> {
  const { clubId, owner, players: [dealer, alice, bob] } = await setupClub(env, { players: ['dealer', 'alice', 'bob'], pointsEach: 100 });
  await grantRole(env, clubId, dealer!.userId, 'dealer');
  const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'Main' }));
  ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({ dealerId: dealer!.userId }));
  return { clubId, owner, dealer: dealer!, alice: alice!, bob: bob!, tableId: table.id };
}

export const coupon = (tableId: string, market: string, stakeCents: number, rounds = 1) =>
  ({ tableId, rounds, selections: [{ market, stakeCents }] });

/** Starts a hand, lets `before` place coupons, then deals the flop. Returns the settled hand. */
export async function playHand(f: Floor, cards: [string, string, string], before?: () => Promise<void>) {
  ok(await f.dealer.post(`/api/dealer/table/${f.tableId}/start-hand`));
  if (before) await before();
  const [card1, card2, card3] = cards;
  return ok(await f.dealer.post(`/api/dealer/table/${f.tableId}/enter-flop`).send({ card1, card2, card3 })).hand;
}

export async function setClubSettings(env: TestEnv, clubId: string, patch: Record<string, unknown>): Promise<void> {
  const [club] = await env.db.select({ settings: clubs.settings }).from(clubs).where(eq(clubs.id, clubId));
  await env.db.update(clubs).set({ settings: { ...club!.settings, ...patch } }).where(eq(clubs.id, clubId));
}

/** Aligns the test clock with the database clock (ledger rows use the database's now()). */
export function syncClock(env: TestEnv): void {
  env.clock.advance(Date.now() - env.clock.now().getTime());
}
