import type { AppContext } from '../../context.js';
import { AppError } from '../../http/errors.js';
import { LEADERBOARD_VISIBLE } from './constants.js';
import { currentHand, tvHand } from './handStats.js';
import { levelProgress, rankLeaderboard } from './levels.js';
import type { TvSessionRow } from './service.js';
import { EMPTY_BOARD, tournamentTvSource, type TournamentTvBoard, type TournamentTvInfo } from './tournamentSource.js';

async function safeBoard(ctx: AppContext, info: TournamentTvInfo): Promise<TournamentTvBoard> {
  try {
    return await tournamentTvSource().board(ctx.db, info);
  } catch (err) {
    ctx.logger.error(`Tournament TV board unavailable for ${info.id}`, err);
    return EMPTY_BOARD;
  }
}

/** Tournament TV payload: hand, level, prize pool, players left and the leaderboard (names and chips are public here). */
export async function tournamentDisplay(ctx: AppContext, session: TvSessionRow) {
  const info = await tournamentTvSource().find(ctx.db, session.targetId);
  if (!info) throw new AppError('tournament.not_found', 404);
  const board = await safeBoard(ctx, info);
  const hand = await currentHand(ctx.db, { tournamentId: info.id });
  const handView = hand ? await tvHand(ctx.db, hand) : null;
  const ranked = rankLeaderboard(board.entries);
  return {
    tournament: { name: info.name, status: info.status, totalHands: board.totalHands, endCondition: board.endCondition },
    currentHand: handView && {
      handNumber: handView.handNumber, status: handView.status, cards: handView.cards,
      winningMarkets: handView.winningMarkets, bettingClosesAt: handView.bettingClosesAt,
    },
    levels: board.levels,
    level: levelProgress(board.levels, hand?.handNumber ?? 0),
    prizePoolCents: board.prizePoolCents,
    guaranteed: board.guaranteed,
    payouts: board.payouts,
    entrants: board.entrants,
    playersLeft: ranked.filter((e) => e.status === 'playing').length,
    leaderboard: ranked.slice(0, LEADERBOARD_VISIBLE),
    more: Math.max(0, ranked.length - LEADERBOARD_VISIBLE),
    serverNow: ctx.now(),
    expiresAt: session.expiresAt,
  };
}
