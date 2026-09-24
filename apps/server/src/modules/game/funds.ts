import type { AppContext } from '../../context.js';
import type { DbOrTx, Tx } from '../../db/client.js';
import { balanceOf, move, POOL, RIDING, wallet } from '../points/ledger.js';

export type Unit = 'points' | 'chips' | 'stars';

export interface FundsOwner {
  readonly clubId: string;
  readonly userId: string;
  readonly tournamentId?: string | null;
  readonly couponId?: string;
}

/**
 * Where a coupon's money lives. Points use the club ledger; tournaments (chips)
 * and the Arena (Stars) register their own implementation.
 */
export interface Funds {
  balance(db: DbOrTx, owner: FundsOwner): Promise<number>;
  /** Debits the whole commitment at placement. */
  commit(ctx: AppContext, tx: Tx, owner: FundsOwner, amount: number): Promise<void>;
  /** A settled pick: the stake leaves "riding"; a win pays `payout` to the player. */
  settle(ctx: AppContext, tx: Tx, owner: FundsOwner, stake: number, payout: number, betId: string): Promise<void>;
  /** Unplayed rounds going back to the player. */
  refund(ctx: AppContext, tx: Tx, owner: FundsOwner, amount: number, kind: string, actorId: string | null): Promise<void>;
}

export const pointsFunds: Funds = {
  balance: (db, o) => balanceOf(db, o.clubId, wallet(o.userId)),
  commit: (_ctx, tx, o, amount) => move(tx, {
    clubId: o.clubId, kind: 'coupon_placed', from: wallet(o.userId), to: RIDING, amountCents: amount,
    actorId: o.userId, refType: 'coupon', refId: o.couponId, shortCode: 'coupon.insufficient_balance',
  }),
  async settle(_ctx, tx, o, stake, payout, betId) {
    await move(tx, { clubId: o.clubId, kind: 'bet_settled', from: RIDING, to: POOL, amountCents: stake, userId: o.userId, refType: 'bet', refId: betId });
    if (payout > 0) {
      await move(tx, {
        clubId: o.clubId, kind: 'bet_won', from: POOL, to: wallet(o.userId), amountCents: payout,
        refType: 'bet', refId: betId, allowNegative: true,
      });
    }
  },
  refund: (_ctx, tx, o, amount, kind, actorId) => move(tx, {
    clubId: o.clubId, kind, from: RIDING, to: wallet(o.userId), amountCents: amount, actorId, refType: 'coupon', refId: o.couponId,
  }),
};

const registry = new Map<Unit, Funds>([['points', pointsFunds]]);

export function registerFunds(unit: Unit, funds: Funds): void {
  registry.set(unit, funds);
}

export function fundsFor(unit: string): Funds {
  const funds = registry.get(unit as Unit);
  if (!funds) throw new Error(`No funds registered for unit ${unit}`);
  return funds;
}
