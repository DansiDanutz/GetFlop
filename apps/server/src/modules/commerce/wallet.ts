import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { clubs, diamondLedger, diamondLots } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { addDays, LOT_VALIDITY_DAYS } from './config.js';

/**
 * The club's Diamond wallet. Every change writes one append-only ledger row;
 * the club balance (clubs.diamonds_balance) always equals the sum of unexpired lots.
 */
export interface LedgerInput {
  readonly clubId: string;
  readonly type: string;
  readonly refType?: string | null;
  readonly refId?: string | null;
  readonly actorId?: string | null;
  readonly note?: string | null;
  readonly data?: Record<string, unknown>;
  readonly at: Date;
}

export type LedgerRow = typeof diamondLedger.$inferSelect;

async function lockBalance(db: DbOrTx, clubId: string): Promise<number> {
  const [row] = await db.select({ balance: clubs.diamondsBalance }).from(clubs).where(eq(clubs.id, clubId)).for('update');
  if (!row) throw new AppError('club.not_found', 404);
  return row.balance;
}

async function writeLedger(db: DbOrTx, input: LedgerInput, amount: number, balanceAfter: number): Promise<LedgerRow> {
  await db.update(clubs).set({ diamondsBalance: balanceAfter }).where(eq(clubs.id, input.clubId));
  const [row] = await db.insert(diamondLedger).values({
    clubId: input.clubId, type: input.type, amount, balanceAfter,
    refType: input.refType ?? null, refId: input.refId ?? null, actorId: input.actorId ?? null,
    note: input.note ?? null, data: input.data ?? null, createdAt: input.at,
  }).returning();
  return row!;
}

export async function balanceOf(db: DbOrTx, clubId: string): Promise<number> {
  const [row] = await db.select({ balance: clubs.diamondsBalance }).from(clubs).where(eq(clubs.id, clubId));
  return row?.balance ?? 0;
}

/** Adds Diamonds as a new lot valid 12 months. */
export async function credit(db: DbOrTx, input: LedgerInput & { amount: number; source: string; orderId?: string | null }): Promise<LedgerRow> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new AppError('commerce.topup_amount_invalid');
  const balance = await lockBalance(db, input.clubId);
  await db.insert(diamondLots).values({
    clubId: input.clubId, source: input.source, orderId: input.orderId ?? null,
    originalAmount: input.amount, remaining: input.amount,
    expiresAt: addDays(input.at, LOT_VALIDITY_DAYS), createdAt: input.at,
  });
  return writeLedger(db, input, input.amount, balance + input.amount);
}

/** Lots that can still be spent, oldest expiry first. */
async function spendableLots(db: DbOrTx, clubId: string, at: Date) {
  return db.select().from(diamondLots)
    .where(and(eq(diamondLots.clubId, clubId), gt(diamondLots.remaining, 0), gt(diamondLots.expiresAt, at), isNull(diamondLots.expiredAt)))
    .orderBy(asc(diamondLots.expiresAt), asc(diamondLots.createdAt))
    .for('update');
}

/** Takes `amount` from lots, oldest first. Returns the amount per lot taken. */
async function drainLots(db: DbOrTx, lots: readonly (typeof diamondLots.$inferSelect)[], amount: number): Promise<number> {
  let left = amount;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(lot.remaining, left);
    await db.update(diamondLots).set({ remaining: sql`${diamondLots.remaining} - ${take}` }).where(eq(diamondLots.id, lot.id));
    left -= take;
  }
  return amount - left;
}

/** Spends Diamonds FIFO. Throws `shortCode` when the balance cannot cover it. */
export async function debit(db: DbOrTx, input: LedgerInput & { amount: number; shortCode?: string }): Promise<LedgerRow> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error(`Invalid debit ${input.amount}`);
  const balance = await lockBalance(db, input.clubId);
  if (balance < input.amount) {
    throw new AppError(input.shortCode ?? 'commerce.level_insufficient_diamonds', 409, {
      costD: input.amount, balanceD: balance, shortfallD: input.amount - balance,
    });
  }
  const taken = await drainLots(db, await spendableLots(db, input.clubId, input.at), input.amount);
  if (taken !== input.amount) throw new Error(`Diamond lots out of sync for club ${input.clubId}`);
  return writeLedger(db, input, -input.amount, balance - input.amount);
}

/**
 * Takes back up to `amount` still unspent from one order's lot (card refund).
 * Returns what was taken; the rest was already spent.
 */
export async function takeBackFromOrder(db: DbOrTx, input: LedgerInput & { orderId: string; amount: number }): Promise<number> {
  const balance = await lockBalance(db, input.clubId);
  const lots = await db.select().from(diamondLots)
    .where(and(eq(diamondLots.clubId, input.clubId), eq(diamondLots.orderId, input.orderId), gt(diamondLots.remaining, 0), isNull(diamondLots.expiredAt)))
    .for('update');
  const taken = await drainLots(db, lots, Math.min(input.amount, balance));
  if (taken > 0) await writeLedger(db, input, -taken, balance - taken);
  return taken;
}

/** Expires lots past their 12 months. Returns the Diamonds expired per club. */
export async function expireLots(db: DbOrTx, at: Date): Promise<Map<string, number>> {
  const due = await db.select().from(diamondLots)
    .where(and(lte(diamondLots.expiresAt, at), isNull(diamondLots.expiredAt)))
    .orderBy(asc(diamondLots.clubId), asc(diamondLots.expiresAt));
  const perClub = new Map<string, number>();
  for (const lot of due) {
    await db.update(diamondLots).set({ expiredAt: at, remaining: 0 }).where(eq(diamondLots.id, lot.id));
    if (lot.remaining <= 0) continue;
    const balance = await lockBalance(db, lot.clubId);
    await writeLedger(db, {
      clubId: lot.clubId, type: 'expiry', refType: 'lot', refId: lot.id, at,
      data: { purchasedAt: lot.createdAt.toISOString() },
    }, -lot.remaining, balance - lot.remaining);
    perClub.set(lot.clubId, (perClub.get(lot.clubId) ?? 0) + lot.remaining);
  }
  return perClub;
}

/** The next lot to expire: "d D expire on <date>". */
export async function nextExpiry(db: DbOrTx, clubId: string, at: Date): Promise<{ amount: number; expiresAt: Date } | null> {
  const [lot] = await db.select().from(diamondLots)
    .where(and(eq(diamondLots.clubId, clubId), gt(diamondLots.remaining, 0), gt(diamondLots.expiresAt, at), isNull(diamondLots.expiredAt)))
    .orderBy(asc(diamondLots.expiresAt)).limit(1);
  return lot ? { amount: lot.remaining, expiresAt: lot.expiresAt } : null;
}
