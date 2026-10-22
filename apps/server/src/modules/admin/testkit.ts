import { grantRole, setupClub } from '../../test/fixtures.js';
import { ok, type Agent, type TestEnv } from '../../test/harness.js';

export interface TableSetup {
  readonly clubId: string;
  readonly owner: Agent;
  readonly dealer: Agent;
  readonly alice: Agent;
  readonly bob: Agent;
  readonly tableId: string;
}

/** A club with an open Ring Game dealt by `dealer`; Alice and Bob hold 100 PTS each. */
export async function openTable(env: TestEnv, clubName?: string, prefix = ''): Promise<TableSetup> {
  const names = [`${prefix}dealer`, `${prefix}alice`, `${prefix}bob`];
  const { clubId, owner, players: [dealer, alice, bob] } = await setupClub(env, {
    players: names, pointsEach: 100, owner: `${prefix}owner`, clubName,
  });
  await grantRole(env, clubId, dealer!.userId, 'dealer');
  const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'Table 1', game: 'nlh' }));
  ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({ dealerId: dealer!.userId }));
  return { clubId, owner, dealer: dealer!, alice: alice!, bob: bob!, tableId: table.id };
}

export const couponBody = (tableId: string, markets: string[], stakeCents: number, rounds = 1) =>
  ({ tableId, rounds, selections: markets.map((market) => ({ market, stakeCents })) });

export async function startHand(dealer: Agent, tableId: string): Promise<string> {
  return ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`)).hand.id as string;
}

export async function flop(dealer: Agent, tableId: string, cards: [string, string, string]) {
  return ok(await dealer.post(`/api/dealer/table/${tableId}/enter-flop`).send({ card1: cards[0], card2: cards[1], card3: cards[2] }));
}

export const balanceOf = async (a: Agent): Promise<number> => ok(await a.get('/api/player/balance')).balanceCents as number;

export async function supplyOf(owner: Agent, clubId: string): Promise<{ drift: number; riding: number }> {
  return ok(await owner.get(`/api/clubs/${clubId}/points`));
}
