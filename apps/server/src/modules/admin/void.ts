import { eq, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { Tx } from '../../db/client.js';
import { bets, coupons, hands, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import type { AuthUser } from '../auth/session.js';
import { balanceOf, move, POOL, wallet } from '../points/ledger.js';
import { writeAudit } from './audit.js';

type BetRow = typeof bets.$inferSelect;

async function lockSettledBet(tx: Tx, betId: string): Promise<BetRow> {
  const [bet] = await tx.select().from(bets).where(eq(bets.id, betId)).for('update');
  if (!bet) throw new AppError('admin.bet_not_found', 404);
  if (bet.status === 'voided') throw new AppError('admin.bet_already_voided', 409);
  if (bet.status !== 'won' && bet.status !== 'lost') throw new AppError('admin.bet_not_settled', 409);
  const [coupon] = await tx.select({ unit: coupons.unit }).from(coupons).where(eq(coupons.id, bet.couponId));
  if (coupon?.unit !== 'points') throw new AppError('admin.bet_unit_unsupported', 409);
  return bet;
}

/**
 * Ledger side of a void. The stake goes back from the pool; a won pick also gives
 * its payout back to the pool. Both rows are `bet_refunded` with the reason.
 * The wallet may go below zero when the win was already spent: the correction is always applied.
 */
async function reverseMoney(tx: Tx, bet: BetRow, actorId: string, reason: string): Promise<void> {
  const common = { clubId: bet.clubId, kind: 'bet_refunded', actorId, userId: bet.userId, note: reason, refType: 'bet', refId: bet.id, allowNegative: true };
  await move(tx, { ...common, from: POOL, to: wallet(bet.userId), amountCents: bet.stakeCents });
  if (bet.status === 'won' && bet.payoutCents > 0) {
    await move(tx, { ...common, from: wallet(bet.userId), to: POOL, amountCents: bet.payoutCents });
  }
}

/** Removes the pick from the hand and coupon totals. */
async function adjustTotals(tx: Tx, bet: BetRow): Promise<void> {
  const won = bet.status === 'won';
  await tx.update(hands).set({
    totalBets: sql`${hands.totalBets} - 1`,
    winningBets: sql`${hands.winningBets} - ${won ? 1 : 0}`,
    totalWageredCents: sql`${hands.totalWageredCents} - ${bet.stakeCents}`,
    totalPaidOutCents: sql`${hands.totalPaidOutCents} - ${bet.payoutCents}`,
  }).where(eq(hands.id, bet.handId));
  await tx.update(coupons).set({
    wonCents: sql`${coupons.wonCents} - ${bet.payoutCents}`,
    refundedCents: sql`${coupons.refundedCents} + ${bet.stakeCents}`,
  }).where(eq(coupons.id, bet.couponId));
}

/** Admin void of a settled pick (spec 01 §6.1): lost → stake back; won → win taken back and stake returned. */
export async function voidBet(ctx: AppContext, actor: AuthUser, betId: string, reasonInput: string | undefined) {
  const reason = reasonInput?.trim() ?? '';
  if (!reason) throw new AppError('admin.reason_required');
  const result = await ctx.db.transaction(async (tx) => {
    const bet = await lockSettledBet(tx, betId);
    await reverseMoney(tx, bet, actor.id, reason);
    await adjustTotals(tx, bet);
    const [voided] = await tx.update(bets).set({ status: 'voided', payoutCents: 0, voidReason: reason }).where(eq(bets.id, bet.id)).returning();
    await writeAudit(tx, ctx.now(), {
      actorId: actor.id, action: 'void_bet', clubId: bet.clubId, targetType: 'bet', targetId: bet.id,
      data: {
        reason, previousStatus: bet.status, stakeCents: bet.stakeCents, payoutCents: bet.payoutCents,
        userId: bet.userId, handId: bet.handId, market: bet.market,
      },
    });
    const balanceCents = await balanceOf(tx, bet.clubId, wallet(bet.userId));
    const [player] = await tx.select({ username: users.username, displayName: users.displayName }).from(users).where(eq(users.id, bet.userId));
    return { bet, voided: voided!, balanceCents, playerName: player?.displayName ?? player?.username ?? '' };
  });
  const { bet, voided, balanceCents, playerName } = result;
  ctx.events.emit(rooms.user(bet.userId), 'balance:updated', { clubId: bet.clubId, balanceCents });
  ctx.events.emit(rooms.staff(bet.clubId), 'live:changed', { clubId: bet.clubId, kind: 'points' });
  return {
    bet: { id: voided.id, status: voided.status, voidReason: voided.voidReason, stakeCents: voided.stakeCents, market: voided.market },
    balanceChangeCents: bet.stakeCents - bet.payoutCents,
    balanceCents,
    playerName,
  };
}
