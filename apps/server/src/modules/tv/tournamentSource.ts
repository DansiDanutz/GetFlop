import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { tournaments } from '../../db/schema/index.js';
import { collectedCents, standingsOf } from '../tournaments/lifecycle.js';
import { placeShares } from '../tournaments/rules.js';
import { entriesOf } from '../tournaments/store.js';
import { poolNow } from '../tournaments/views.js';
import type { TvEntry, TvLevel } from './levels.js';

/**
 * Adapter between the TV and the tournaments module (owned by another team).
 * The default source reads the tournaments module's tables and read-model helpers
 * (read only). Tests, or a later tournaments refactor, can swap it with
 * setTournamentTvSource(). If building the board fails the TV degrades to an empty board.
 */
export interface TournamentTvInfo {
  readonly id: string;
  readonly clubId: string;
  readonly name: string;
  /** upcoming | active | finished | cancelled */
  readonly status: string;
  readonly tableId: string | null;
}

export interface TournamentTvBoard {
  readonly totalHands: number | null;
  /** hands | manual */
  readonly endCondition: string;
  readonly levels: readonly TvLevel[];
  readonly prizePoolCents: number;
  readonly guaranteed: boolean;
  readonly payouts: readonly { readonly place: number; readonly amountCents: number }[];
  readonly entrants: number;
  readonly entries: readonly TvEntry[];
}

export interface TournamentTvSource {
  find(db: DbOrTx, id: string): Promise<TournamentTvInfo | null>;
  board(db: DbOrTx, info: TournamentTvInfo): Promise<TournamentTvBoard>;
}

export const EMPTY_BOARD: TournamentTvBoard = {
  totalHands: null, endCondition: 'manual', levels: [], prizePoolCents: 0, guaranteed: false, payouts: [], entrants: 0, entries: [],
};

/** Entry statuses still in the event (the rest are out: busted, eliminated). */
const IN_PLAY = new Set(['registered', 'active']);

/** Reads through the tournaments module's own read model (standings, pool, payout shares). */
export const defaultTournamentTvSource: TournamentTvSource = {
  async find(db, id) {
    const [t] = await db.select().from(tournaments).where(eq(tournaments.id, id)).limit(1);
    return t ? { id: t.id, clubId: t.clubId, name: t.name, status: t.status, tableId: t.tableId } : null;
  },
  async board(db, info) {
    const [t] = await db.select().from(tournaments).where(eq(tournaments.id, info.id)).limit(1);
    if (!t) return EMPTY_BOARD;
    const pool = poolNow(t, await collectedCents(db, t));
    const entries = await entriesOf(db, t.id);
    const inPlayChips = new Map(entries.map((e) => [e.userId, e.chipsInPlay]));
    const standings = await standingsOf(db, t, entries, pool);
    const isFinished = t.status === 'finished';
    return {
      totalHands: t.endCondition === 'hands' ? t.endValue : null,
      endCondition: t.endCondition,
      levels: t.levels,
      prizePoolCents: pool,
      guaranteed: t.prizePoolType === 'guaranteed',
      payouts: placeShares(pool, t.payoutStructure).map((amountCents, i) => ({ place: i + 1, amountCents })),
      entrants: entries.length,
      entries: standings.map((s): TvEntry => ({
        name: s.username,
        chips: s.chips + (inPlayChips.get(s.userId) ?? 0),
        status: IN_PLAY.has(s.status) && !isFinished ? 'playing' : 'finished',
        place: s.position,
        payoutCents: isFinished ? s.prizeCents : 0,
      })),
    };
  },
};

let current: TournamentTvSource = defaultTournamentTvSource;

/** The tournaments module (or a test) plugs in an exact source. */
export function setTournamentTvSource(source: TournamentTvSource): void {
  current = source;
}

export function resetTournamentTvSource(): void {
  current = defaultTournamentTvSource;
}

export function tournamentTvSource(): TournamentTvSource {
  return current;
}
