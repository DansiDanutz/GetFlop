import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { arenaPlayers, starAccounts, starLedger, type StarAccountKind } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { Funds } from '../game/funds.js';
import { arenaConfig } from './config.js';
import { weekKey } from './time.js';

export interface StarAccountRef {
  readonly kind: StarAccountKind;
  readonly userId?: string;
}

export const HOUSE: StarAccountRef = { kind: 'house' };
export const RIDING: StarAccountRef = { kind: 'riding' };
export const starWallet = (userId: string): StarAccountRef => ({ kind: 'wallet', userId });

type StarAccount = typeof starAccounts.$inferSelect;

async function account(db: DbOrTx, ref: StarAccountRef): Promise<StarAccount> {
  const where = and(
    eq(starAccounts.kind, ref.kind),
    ref.userId ? eq(starAccounts.userId, ref.userId) : isNull(starAccounts.userId),
  );
  const [found] = await db.select().from(starAccounts).where(where).limit(1);
  if (found) return found;
  await db.insert(starAccounts).values({ kind: ref.kind, userId: ref.userId ?? null }).onConflictDoNothing();
  const [created] = await db.select().from(starAccounts).where(where).limit(1);
  return created!;
}

export async function starBalance(db: DbOrTx, userId: string): Promise<number> {
  const [row] = await db.select({ b: starAccounts.balanceCents }).from(starAccounts)
    .where(and(eq(starAccounts.kind, 'wallet'), eq(starAccounts.userId, userId))).limit(1);
  return row?.b ?? 0;
}

export interface StarMove {
  readonly kind: string;
  /** null = Stars issued (welcome, refill, purchase). */
  readonly from: StarAccountRef | null;
  readonly to: StarAccountRef;
  readonly amountCents: number;
  readonly userId?: string;
  readonly refType?: string;
  readonly refId?: string;
  readonly allowNegative?: boolean;
  readonly shortCode?: string;
}

async function adjust(db: DbOrTx, acct: StarAccount, delta: number): Promise<number> {
  const [row] = await db.update(starAccounts).set({ balanceCents: sql`${starAccounts.balanceCents} + ${delta}` })
    .where(eq(starAccounts.id, acct.id)).returning({ b: starAccounts.balanceCents });
  return row!.b;
}

/** Moves Stars between two accounts and appends one immutable ledger row. */
export async function moveStars(db: DbOrTx, m: StarMove): Promise<void> {
  if (!Number.isInteger(m.amountCents) || m.amountCents <= 0) throw new AppError('points.amount_invalid');
  const from = m.from ? await account(db, m.from) : null;
  const to = await account(db, m.to);
  if (from) {
    const [locked] = await db.select({ b: starAccounts.balanceCents }).from(starAccounts).where(eq(starAccounts.id, from.id)).for('update');
    if (!m.allowNegative && locked!.b < m.amountCents) {
      throw new AppError(m.shortCode ?? 'coupon.insufficient_balance', 409, { balance: locked!.b, needed: m.amountCents });
    }
  }
  const fromAfter = from ? await adjust(db, from, -m.amountCents) : null;
  const toAfter = await adjust(db, to, m.amountCents);
  await db.insert(starLedger).values({
    kind: m.kind, fromAccountId: from?.id ?? null, toAccountId: to.id, amountCents: m.amountCents,
    fromBalanceAfter: fromAfter, toBalanceAfter: toAfter, userId: m.userId ?? m.to.userId ?? m.from?.userId ?? null,
    refType: m.refType, refId: m.refId,
  });
}

/** Records the week a player's balance fell under the comeback floor. */
async function markLow(db: DbOrTx, userId: string, now: Date): Promise<void> {
  const cfg = arenaConfig();
  if (await starBalance(db, userId) >= cfg.comebackFloorCents) return;
  await db.update(arenaPlayers).set({ lowWeek: weekKey(now, cfg.timeZone) }).where(eq(arenaPlayers.userId, userId));
}

/** Arena coupons: wallet → riding at placement; each pick's stake goes to the house, a win comes back from it. */
export const starsFunds: Funds = {
  balance: (db, o) => starBalance(db, o.userId),
  async commit(ctx, tx, o, amount) {
    await moveStars(tx, {
      kind: 'coupon_placed', from: starWallet(o.userId), to: RIDING, amountCents: amount, userId: o.userId,
      refType: 'coupon', refId: o.couponId, shortCode: 'coupon.insufficient_balance',
    });
    await markLow(tx, o.userId, ctx.now());
  },
  async settle(_ctx, tx, o, stake, payout, betId) {
    await moveStars(tx, { kind: 'bet_settled', from: RIDING, to: HOUSE, amountCents: stake, userId: o.userId, refType: 'bet', refId: betId });
    if (payout > 0) {
      await moveStars(tx, {
        kind: 'bet_won', from: HOUSE, to: starWallet(o.userId), amountCents: payout, refType: 'bet', refId: betId, allowNegative: true,
      });
    }
  },
  refund: (_ctx, tx, o, amount, kind) => moveStars(tx, {
    kind, from: RIDING, to: starWallet(o.userId), amountCents: amount, refType: 'coupon', refId: o.couponId,
  }),
};

export interface StarSupply {
  readonly inWallets: number;
  readonly riding: number;
  readonly house: number;
  readonly issued: number;
  /** holdings − issued; 0 when everything adds up. */
  readonly drift: number;
}

export async function starSupply(db: DbOrTx): Promise<StarSupply> {
  const rows = await db.select({ kind: starAccounts.kind, total: sql<string>`coalesce(sum(${starAccounts.balanceCents}), 0)` })
    .from(starAccounts).groupBy(starAccounts.kind);
  const held = (k: StarAccountKind) => Number(rows.find((r) => r.kind === k)?.total ?? 0);
  const [issued] = await db.select({ n: sql<string>`coalesce(sum(${starLedger.amountCents}), 0)` }).from(starLedger)
    .where(isNull(starLedger.fromAccountId));
  const s = { inWallets: held('wallet'), riding: held('riding'), house: held('house'), issued: Number(issued?.n ?? 0) };
  return { ...s, drift: s.inWallets + s.riding + s.house - s.issued };
}
