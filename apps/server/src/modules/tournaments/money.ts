/**
 * Points movements of tournaments. Buy-ins, rebuy and add-on costs go to the tournament's
 * prize pool account; fees go to the club pool. Everything goes through the ledger.
 */
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { pointAccounts } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { balanceOf, move, POOL, prizePool, wallet } from '../points/ledger.js';
import type { EntryRow } from './store.js';

export interface Charge {
  readonly clubId: string;
  readonly userId: string;
  readonly tournamentId: string;
  /** Goes to the prize pool. */
  readonly poolCents: number;
  /** Goes to the club. */
  readonly feeCents: number;
  /** tournament_buyin | tournament_rebuy | tournament_addon */
  readonly kind: string;
}

/** Takes buy-in (or rebuy / add-on) + fee from the player's wallet. */
export async function chargeEntry(tx: Tx, c: Charge): Promise<void> {
  const total = c.poolCents + c.feeCents;
  if (total === 0) return;
  const [acct] = await tx.select({ id: pointAccounts.id }).from(pointAccounts)
    .where(and(eq(pointAccounts.clubId, c.clubId), eq(pointAccounts.kind, 'player'), eq(pointAccounts.userId, c.userId))).limit(1);
  if (!acct) throw new AppError('trm.no_wallet', 409);
  if ((await balanceOf(tx, c.clubId, wallet(c.userId))) < total) {
    throw new AppError('trm.insufficient_balance', 409, { amount: total });
  }
  const common = { clubId: c.clubId, kind: c.kind, from: wallet(c.userId), actorId: c.userId, refType: 'tournament', refId: c.tournamentId };
  if (c.poolCents > 0) await move(tx, { ...common, to: prizePool(c.tournamentId), amountCents: c.poolCents, shortCode: 'trm.insufficient_balance' });
  if (c.feeCents > 0) await move(tx, { ...common, to: POOL, amountCents: c.feeCents, note: 'fee', shortCode: 'trm.insufficient_balance' });
}

/** Gives back everything an entry paid (unregister or cancel). */
export async function refundEntry(tx: Tx, clubId: string, tournamentId: string, entry: EntryRow, actorId: string | null): Promise<number> {
  const common = { clubId, kind: 'tournament_refund', to: wallet(entry.userId), actorId, refType: 'tournament', refId: tournamentId };
  if (entry.paidCents > 0) await move(tx, { ...common, from: prizePool(tournamentId), amountCents: entry.paidCents });
  // The club already holds the fee; a refund never fails because the pool was spent meanwhile.
  if (entry.feesCents > 0) await move(tx, { ...common, from: POOL, amountCents: entry.feesCents, note: 'fee', allowNegative: true });
  return entry.paidCents + entry.feesCents;
}
