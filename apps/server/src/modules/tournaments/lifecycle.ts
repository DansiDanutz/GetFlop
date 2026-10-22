/**
 * Ending a tournament: cancelling the live hand, voiding live coupons (chips back to the
 * stacks), final standings and prizes, and cancel refunds.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { Tx } from '../../db/client.js';
import { bets, clubTables, couponLegs, coupons, hands, tournamentEntries, tournaments } from '../../db/schema/index.js';
import { liveHand } from '../game/tables.js';
import { balanceOf, move, POOL, prizePool, wallet } from '../points/ledger.js';
import { chipsFunds } from './chips.js';
import { refundEntry } from './money.js';
import { assignPrizes, placeShares, prizePoolCents, rankEntries } from './rules.js';
import { entriesOf, logEvent, namesOf, type EntryRow, type TournamentRow } from './store.js';

export interface VoidedCoupon {
  readonly couponId: string;
  readonly userId: string;
  readonly refundCents: number;
  readonly roundsUnresolved: number;
}

/** Voids live coupons of the tournament (optionally one player's); unplayed rounds go back to the stack. */
export async function voidTournamentCoupons(ctx: AppContext, tx: Tx, t: TournamentRow, userId?: string): Promise<VoidedCoupon[]> {
  const conditions = [eq(coupons.tournamentId, t.id), eq(coupons.status, 'live')];
  if (userId) conditions.push(eq(coupons.userId, userId));
  const live = await tx.select().from(coupons).where(and(...conditions));
  if (live.length === 0) return [];
  const legs = await tx.select().from(couponLegs)
    .where(and(inArray(couponLegs.couponId, live.map((c) => c.id)), eq(couponLegs.status, 'active')));
  const out: VoidedCoupon[] = [];
  for (const c of live) {
    const perRound = legs.filter((l) => l.couponId === c.id).reduce((s, l) => s + l.stakeCents, 0);
    const roundsUnresolved = c.rounds - c.roundsSettled;
    const refundCents = perRound * roundsUnresolved;
    if (refundCents > 0) {
      await chipsFunds.refund(ctx, tx, { clubId: c.clubId, userId: c.userId, tournamentId: t.id, couponId: c.id }, refundCents, 'coupon_voided', null);
    }
    await tx.update(coupons).set({ status: 'voided', refundedCents: c.refundedCents + refundCents, finishedAt: ctx.now() })
      .where(eq(coupons.id, c.id));
    out.push({ couponId: c.id, userId: c.userId, refundCents, roundsUnresolved });
  }
  return out;
}

/** Cancels the tournament table's live hand: its picks are released, no round is used. */
export async function cancelLiveHand(ctx: AppContext, tx: Tx, t: TournamentRow) {
  const hand = await liveHand(tx, t.tableId);
  if (!hand) return null;
  await tx.update(bets).set({ status: 'refunded' }).where(and(eq(bets.handId, hand.id), eq(bets.status, 'pending')));
  const [cancelled] = await tx.update(hands).set({ status: 'cancelled', cancelledAt: ctx.now() }).where(eq(hands.id, hand.id)).returning();
  return cancelled!;
}

async function closeTournamentTable(tx: Tx, t: TournamentRow): Promise<void> {
  await tx.update(clubTables).set({ status: 'closed', dealerId: null, isAutoDeal: false }).where(eq(clubTables.id, t.tableId));
}

export interface Standing {
  readonly userId: string;
  readonly username: string;
  readonly isBot: boolean;
  readonly position: number;
  readonly chips: number;
  readonly status: string;
  readonly eliminatedReason: string | null;
  readonly outAtHand: number | null;
  readonly rebuys: number;
  readonly addons: number;
  readonly prizeCents: number;
}

/** Ranked standings with the prize each place would get from `poolCents` right now. */
export async function standingsOf(tx: Tx | AppContext['db'], t: TournamentRow, entries: EntryRow[], poolCents: number): Promise<Standing[]> {
  const ranked = rankEntries(entries.map((e) => ({ ...e, chips: e.chips + e.chipsInPlay })));
  const prizes = assignPrizes(ranked, placeShares(poolCents, t.payoutStructure));
  const names = await namesOf(tx, entries.map((e) => e.userId));
  return ranked.map(({ entry, position }, i) => ({
    userId: entry.userId, username: names.get(entry.userId)?.name ?? '', isBot: entry.isBot, position,
    chips: entry.chips, status: entry.status, eliminatedReason: entry.eliminatedReason, outAtHand: entry.outAtHand,
    rebuys: entry.rebuys, addons: entry.addons,
    prizeCents: t.status === 'finished' ? entry.prizeCents : prizes[i] ?? 0,
  }));
}

export async function collectedCents(tx: Tx | AppContext['db'], t: TournamentRow): Promise<number> {
  return balanceOf(tx, t.clubId, prizePool(t.id));
}

export interface FinishResult {
  readonly tournament: TournamentRow;
  readonly standings: Standing[];
  readonly poolCents: number;
  readonly voided: VoidedCoupon[];
  readonly cancelledHandId: string | null;
}

/**
 * Ends the tournament now: prizes by current standings (docs/spec/10 §9). Guaranteed
 * shortfall comes from the club pool; unpaid places and bot prizes return to the club.
 */
export async function finishTournament(ctx: AppContext, tx: Tx, t: TournamentRow, actorId: string | null): Promise<FinishResult> {
  const cancelled = await cancelLiveHand(ctx, tx, t);
  const voided = await voidTournamentCoupons(ctx, tx, t);
  const entries = await entriesOf(tx, t.id);
  const collected = await collectedCents(tx, t);
  const poolCents = entries.length === 0 ? collected : prizePoolCents(t.prizePoolType, t.guaranteedPrizeCents, collected);
  if (poolCents > collected) {
    await move(tx, {
      clubId: t.clubId, kind: 'tournament_guarantee', from: POOL, to: prizePool(t.id), amountCents: poolCents - collected,
      actorId, refType: 'tournament', refId: t.id, allowNegative: true,
    });
  }
  const ranked = rankEntries(entries.map((e) => ({ ...e, chips: e.chips + e.chipsInPlay })));
  const prizes = assignPrizes(ranked, placeShares(poolCents, t.payoutStructure));
  for (const [i, { entry, position }] of ranked.entries()) {
    const prize = entry.isBot ? 0 : prizes[i] ?? 0;
    if (prize > 0) {
      await move(tx, {
        clubId: t.clubId, kind: 'tournament_payout', from: prizePool(t.id), to: wallet(entry.userId), amountCents: prize,
        actorId, refType: 'tournament', refId: t.id,
      });
    }
    await tx.update(tournamentEntries).set({ finishPosition: position, prizeCents: prize }).where(eq(tournamentEntries.id, entry.id));
  }
  const leftover = await collectedCents(tx, t);
  if (leftover > 0) {
    await move(tx, {
      clubId: t.clubId, kind: 'tournament_result', from: prizePool(t.id), to: POOL, amountCents: leftover,
      actorId, refType: 'tournament', refId: t.id,
    });
  }
  const [finished] = await tx.update(tournaments).set({ status: 'finished', finishedAt: ctx.now(), finalPoolCents: poolCents })
    .where(eq(tournaments.id, t.id)).returning();
  await closeTournamentTable(tx, t);
  await logEvent(tx, t.id, 'finished', { poolCents, entrants: entries.length, by: actorId ? 'staff' : 'auto' });
  const standings = await standingsOf(tx, finished!, await entriesOf(tx, t.id), poolCents);
  return { tournament: finished!, standings, poolCents, voided, cancelledHandId: cancelled?.id ?? null };
}

/** Cancels: every buy-in, fee, rebuy and add-on goes back to the players. */
export async function cancelTournament(ctx: AppContext, tx: Tx, t: TournamentRow, actorId: string) {
  const cancelled = await cancelLiveHand(ctx, tx, t);
  const voided = await voidTournamentCoupons(ctx, tx, t);
  const entries = await entriesOf(tx, t.id);
  let refundedCents = 0;
  for (const e of entries) refundedCents += await refundEntry(tx, t.clubId, t.id, e, actorId);
  await tx.update(tournamentEntries).set({ paidCents: 0, feesCents: 0 }).where(eq(tournamentEntries.tournamentId, t.id));
  // Any rounding dust left in the prize pool returns to the club.
  const dust = await collectedCents(tx, t);
  if (dust > 0) {
    await move(tx, { clubId: t.clubId, kind: 'tournament_result', from: prizePool(t.id), to: POOL, amountCents: dust, actorId, refType: 'tournament', refId: t.id });
  }
  const [row] = await tx.update(tournaments).set({ status: 'cancelled', cancelledAt: ctx.now() }).where(eq(tournaments.id, t.id)).returning();
  await closeTournamentTable(tx, t);
  await logEvent(tx, t.id, 'cancelled', { refundedCents, entrants: entries.length });
  return { tournament: row!, refundedCents, voided, cancelledHandId: cancelled?.id ?? null, userIds: entries.map((e) => e.userId) };
}
