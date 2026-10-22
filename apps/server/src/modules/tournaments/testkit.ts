/** Test helpers for the tournaments module (not a test file). */
import { eq } from 'drizzle-orm';
import { clubs } from '../../db/schema/index.js';
import { grantRole, setupClub } from '../../test/fixtures.js';
import { ok, type Agent, type TestEnv } from '../../test/harness.js';
import { DEFAULT_LEVELS } from './rules.js';

export interface TournamentWorld {
  readonly clubId: string;
  readonly owner: Agent;
  readonly dealer: Agent;
  readonly players: Agent[];
}

/** A Club 100 club (one tournament at a time) with a dealer and players holding 100 PTS each. */
export async function tournamentWorld(env: TestEnv, names = ['alice', 'bob', 'carol'], level = 'club100'): Promise<TournamentWorld> {
  const { clubId, owner, players } = await setupClub(env, { players: ['dealer', ...names], pointsEach: 100 });
  await grantRole(env, clubId, players[0]!.userId, 'dealer');
  await env.db.update(clubs).set({ level }).where(eq(clubs.id, clubId));
  return { clubId, owner, dealer: players[0]!, players: players.slice(1) };
}

/** A wizard body: auto-dealt, defaults otherwise. */
export function wizardBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'Friday Freezeout', autoDealSeconds: 20, levels: DEFAULT_LEVELS, ...over };
}

/** A short dealer-run event: 2 levels over 4 hands, no participation rule, no late registration. */
export function shortEvent(dealerId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Short Event', dealerId, startingStack: 1_000_000, endValue: 4, minActionPct: 0, allowLateRegistration: false,
    levels: [
      { levelNumber: 1, minBetChips: 10_000, maxBetChips: -1, endHand: 2 },
      { levelNumber: 2, minBetChips: 20_000, maxBetChips: -1, endHand: 4 },
    ],
    allowedBetTypeIds: ['rainbow', 'same-color', 'has-ace', 'any-pair'],
    ...over,
  };
}

export async function create(owner: Agent, body: Record<string, unknown>): Promise<{ id: string; tableId: string }> {
  return ok(await owner.post('/api/tournaments').send(body)).tournament;
}

export const balance = async (a: Agent): Promise<number> => ok(await a.get('/api/player/balance')).balanceCents as number;

export const pick = (tableId: string, market: string, stakeCents: number, rounds = 1) =>
  ({ tableId, rounds, selections: [{ market, stakeCents }] });

/** Deals one hand on a dealer-run table: open, then the given flop. */
export async function dealHand(dealer: Agent, tableId: string, flop: [string, string, string], before?: () => Promise<void>): Promise<void> {
  ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`));
  if (before) await before();
  ok(await dealer.post(`/api/dealer/table/${tableId}/enter-flop`).send({ card1: flop[0], card2: flop[1], card3: flop[2] }));
}

/** Rainbow wins, nothing paired: Qc 7h 3s. */
export const RAINBOW: [string, string, string] = ['Qc', '7h', '3s'];
/** Paired, two suits: 7h 7d 2h (rainbow loses, any-pair wins). */
export const PAIRED: [string, string, string] = ['7h', '7d', '2h'];
