/** Tournament report (docs/spec/10 §10): duration, chips played / kept, players, biggest hits, markets. */
import { allFlops, MARKETS } from '@getflop/engine';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { bets, hands } from '../../db/schema/index.js';
import { collectedCents, standingsOf } from './lifecycle.js';
import { entriesOf, namesOf, type TournamentRow } from './store.js';
import { poolNow } from './views.js';

const BIGGEST_HITS = 5;
const MINUTE_MS = 60_000;

let probabilities: Map<string, number> | undefined;

/** Exact chance of each market over all 22,100 flops (computed once). */
export function marketProbabilities(): Map<string, number> {
  if (probabilities) return probabilities;
  const flops = allFlops();
  probabilities = new Map(MARKETS.map((m) => [m.slug, flops.filter((f) => m.wins(f)).length / flops.length]));
  return probabilities;
}

interface PlayerLine { picks: number; stakedCents: number; paidCents: number }
interface MarketLine { picks: number; won: number; playedCents: number; paidCents: number; expectedKeptCents: number }

export async function tournamentReport(ctx: AppContext, t: TournamentRow) {
  const rows = await ctx.db.select({ bet: bets, handNumber: hands.handNumber }).from(bets)
    .innerJoin(hands, eq(hands.id, bets.handId))
    .where(and(eq(hands.tournamentId, t.id), inArray(bets.status, ['won', 'lost'])));
  const probs = marketProbabilities();
  const players = new Map<string, PlayerLine>();
  const markets = new Map<string, MarketLine>();
  for (const { bet } of rows) {
    const p = players.get(bet.userId) ?? { picks: 0, stakedCents: 0, paidCents: 0 };
    players.set(bet.userId, { picks: p.picks + 1, stakedCents: p.stakedCents + bet.stakeCents, paidCents: p.paidCents + bet.payoutCents });
    const m = markets.get(bet.market) ?? { picks: 0, won: 0, playedCents: 0, paidCents: 0, expectedKeptCents: 0 };
    const edge = 1 - (probs.get(bet.market) ?? 0) * (bet.multiplierX100 / 100);
    markets.set(bet.market, {
      picks: m.picks + 1, won: m.won + (bet.status === 'won' ? 1 : 0), playedCents: m.playedCents + bet.stakeCents,
      paidCents: m.paidCents + bet.payoutCents, expectedKeptCents: m.expectedKeptCents + bet.stakeCents * edge,
    });
  }
  const entries = await entriesOf(ctx.db, t.id);
  const names = await namesOf(ctx.db, [...entries.map((e) => e.userId), ...players.keys()]);
  const played = rows.reduce((s, r) => s + r.bet.stakeCents, 0);
  const paid = rows.reduce((s, r) => s + r.bet.payoutCents, 0);
  const end = t.finishedAt ?? t.cancelledAt ?? ctx.now();
  const pool = poolNow(t, await collectedCents(ctx.db, t));
  return {
    tournament: { id: t.id, name: t.name, status: t.status, startedAt: t.startedAt, finishedAt: t.finishedAt, handsPlayed: t.handsPlayed },
    durationMinutes: t.startedAt ? Math.max(0, Math.round((end.getTime() - t.startedAt.getTime()) / MINUTE_MS)) : 0,
    chipsPlayed: played, chipsPaid: paid, chipsKept: played - paid, poolCents: pool,
    standings: await standingsOf(ctx.db, t, entries, pool),
    players: entries.map((e) => {
      const line = players.get(e.userId) ?? { picks: 0, stakedCents: 0, paidCents: 0 };
      return {
        userId: e.userId, username: names.get(e.userId)?.name ?? '', isBot: e.isBot, picks: line.picks,
        avgStakeCents: line.picks > 0 ? Math.round(line.stakedCents / line.picks) : 0, netCents: line.paidCents - line.stakedCents,
        status: e.status, outReason: e.eliminatedReason, outAtHand: e.outAtHand,
      };
    }),
    biggestHits: rows.filter((r) => r.bet.status === 'won')
      .sort((a, b) => (b.bet.payoutCents - b.bet.stakeCents) - (a.bet.payoutCents - a.bet.stakeCents)).slice(0, BIGGEST_HITS)
      .map(({ bet, handNumber }) => ({
        username: names.get(bet.userId)?.name ?? '', handNumber, market: bet.market, stakeCents: bet.stakeCents,
        payoutCents: bet.payoutCents, netCents: bet.payoutCents - bet.stakeCents,
      })),
    byMarket: [...markets.entries()].map(([market, m]) => ({
      market, picks: m.picks, won: m.won, playedCents: m.playedCents, keptCents: m.playedCents - m.paidCents,
      expectedKeptCents: Math.round(m.expectedKeptCents),
    })).sort((a, b) => b.playedCents - a.playedCents),
  };
}
