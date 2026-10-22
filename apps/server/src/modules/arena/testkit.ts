import { ok, type Agent, type TestEnv } from '../../test/harness.js';
import { enterFlop, startHand } from '../game/hands.js';
import { liveHand } from '../game/tables.js';
import { ensureArena, type ArenaIds } from './setup.js';

export const STAR = 100;

export interface ArenaWorld {
  readonly ids: ArenaIds;
  readonly players: Agent[];
}

/** Signs players in and enters each into the Arena (welcome grant). */
export async function arenaWorld(env: TestEnv, names: string[] = ['alice']): Promise<ArenaWorld> {
  const players: Agent[] = [];
  for (const name of names) {
    const agent = await env.login(name);
    ok(await agent.post('/api/arena/enter').send({}));
    players.push(agent);
  }
  return { ids: await ensureArena(env.ctx), players };
}

export const stars = async (a: Agent): Promise<number> => ok(await a.get('/api/arena/summary')).balanceCents as number;

export const picks = (tableId: string, markets: string[], stakeCents: number, rounds = 1) =>
  ({ tableId, rounds, selections: markets.map((market) => ({ market, stakeCents })) });

/** Settles the current Arena hand with chosen cards (starting one if none is live). */
export async function dealWith(env: TestEnv, ids: ArenaIds, cards: [string, string, string]) {
  if (!(await liveHand(env.db, ids.tableId))) await startHand(env.ctx, ids.clubId, ids.tableId, { userId: null });
  return enterFlop(env.ctx, ids.clubId, ids.tableId, { userId: null }, cards);
}

/** Flops that win nothing a test plays on (rainbow, no pair, no ace…). */
export const BLANK: [string, string, string] = ['2h', '7d', 'Jc'];
