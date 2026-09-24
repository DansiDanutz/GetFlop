import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { ledgerEntries, pointAccounts, type AccountKind } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';

export interface AccountRef {
  readonly kind: AccountKind;
  readonly userId?: string;
  readonly refId?: string;
}

export const POOL: AccountRef = { kind: 'pool' };
export const RIDING: AccountRef = { kind: 'riding' };
export const wallet = (userId: string): AccountRef => ({ kind: 'player', userId });
export const stock = (userId: string): AccountRef => ({ kind: 'stock', userId });
export const prizePool = (tournamentId: string): AccountRef => ({ kind: 'tournament', refId: tournamentId });

export type Account = typeof pointAccounts.$inferSelect;

/** Finds or creates an account. */
export async function account(db: DbOrTx, clubId: string, ref: AccountRef): Promise<Account> {
  const where = and(
    eq(pointAccounts.clubId, clubId),
    eq(pointAccounts.kind, ref.kind),
    ref.userId ? eq(pointAccounts.userId, ref.userId) : isNull(pointAccounts.userId),
    ref.refId ? eq(pointAccounts.refId, ref.refId) : isNull(pointAccounts.refId),
  );
  const [found] = await db.select().from(pointAccounts).where(where).limit(1);
  if (found) return found;
  await db.insert(pointAccounts)
    .values({ clubId, kind: ref.kind, userId: ref.userId ?? null, refId: ref.refId ?? null })
    .onConflictDoNothing();
  const [created] = await db.select().from(pointAccounts).where(where).limit(1);
  return created!;
}

export async function balanceOf(db: DbOrTx, clubId: string, ref: AccountRef): Promise<number> {
  return (await account(db, clubId, ref)).balanceCents;
}

export interface Movement {
  readonly clubId: string;
  /** Ledger type: mint, deposit, withdrawal, reload, cashout, stock_give, stock_take, coupon_placed, bet_settled, bet_won, … */
  readonly kind: string;
  /** null = Points created (mint) or destroyed. */
  readonly from: AccountRef | null;
  readonly to: AccountRef | null;
  readonly amountCents: number;
  readonly actorId?: string | null;
  /** The player concerned, for member-card filters (defaults to the wallet owner). */
  readonly userId?: string | null;
  readonly note?: string | null;
  readonly refType?: string;
  readonly refId?: string;
  /** Allow the source to go below zero (the pool paying a win). */
  readonly allowNegative?: boolean;
  /** Error code when the source cannot cover the amount. */
  readonly shortCode?: string;
}

async function adjust(db: DbOrTx, acct: Account, delta: number): Promise<number> {
  const [row] = await db.update(pointAccounts)
    .set({ balanceCents: sql`${pointAccounts.balanceCents} + ${delta}` })
    .where(eq(pointAccounts.id, acct.id))
    .returning({ balance: pointAccounts.balanceCents });
  return row!.balance;
}

/**
 * Moves Points between two accounts and appends one immutable ledger row.
 * Must run inside a transaction when combined with other writes.
 */
export async function move(db: DbOrTx, m: Movement): Promise<void> {
  if (!Number.isInteger(m.amountCents) || m.amountCents <= 0) throw new AppError('points.amount_invalid');
  const from = m.from ? await account(db, m.clubId, m.from) : null;
  const to = m.to ? await account(db, m.clubId, m.to) : null;
  if (from) {
    // Lock the source row, then check it covers the amount.
    const [locked] = await db.select({ balance: pointAccounts.balanceCents }).from(pointAccounts)
      .where(eq(pointAccounts.id, from.id)).for('update');
    if (!m.allowNegative && locked!.balance < m.amountCents) {
      throw new AppError(m.shortCode ?? 'points.insufficient', 409, { balance: locked!.balance, needed: m.amountCents });
    }
  }
  const fromAfter = from ? await adjust(db, from, -m.amountCents) : null;
  const toAfter = to ? await adjust(db, to, m.amountCents) : null;
  await db.insert(ledgerEntries).values({
    clubId: m.clubId,
    kind: m.kind,
    fromAccountId: from?.id ?? null,
    toAccountId: to?.id ?? null,
    amountCents: m.amountCents,
    fromBalanceAfter: fromAfter,
    toBalanceAfter: toAfter,
    actorId: m.actorId ?? null,
    userId: m.userId ?? m.to?.userId ?? m.from?.userId ?? null,
    note: m.note ?? null,
    refType: m.refType,
    refId: m.refId,
  });
}

export interface Supply {
  readonly pool: number;
  readonly inStocks: number;
  readonly inWallets: number;
  readonly riding: number;
  readonly inTournaments: number;
  readonly issued: number;
  readonly gameBurned: number;
  readonly gameMinted: number;
  /** holdings − issued; 0 when everything adds up. */
  readonly drift: number;
}

/** "How it adds up": what is held versus what was issued. Never corrects anything. */
export async function supply(db: DbOrTx, clubId: string): Promise<Supply> {
  const rows = await db.select({ kind: pointAccounts.kind, total: sql<string>`coalesce(sum(${pointAccounts.balanceCents}), 0)` })
    .from(pointAccounts).where(eq(pointAccounts.clubId, clubId)).groupBy(pointAccounts.kind);
  const held = (kind: AccountKind) => Number(rows.find((r) => r.kind === kind)?.total ?? 0);
  const [totals] = await db.select({
    issued: sql<string>`coalesce(sum(case when ${ledgerEntries.fromAccountId} is null then ${ledgerEntries.amountCents} else 0 end), 0)
      - coalesce(sum(case when ${ledgerEntries.toAccountId} is null then ${ledgerEntries.amountCents} else 0 end), 0)`,
    burned: sql<string>`coalesce(sum(case when ${ledgerEntries.kind} = 'bet_settled' then ${ledgerEntries.amountCents} else 0 end), 0)`,
    minted: sql<string>`coalesce(sum(case when ${ledgerEntries.kind} = 'bet_won' then ${ledgerEntries.amountCents} else 0 end), 0)`,
  }).from(ledgerEntries).where(eq(ledgerEntries.clubId, clubId));
  const s = {
    pool: held('pool'), inStocks: held('stock'), inWallets: held('player'), riding: held('riding'),
    inTournaments: held('tournament'), issued: Number(totals?.issued ?? 0),
    gameBurned: Number(totals?.burned ?? 0), gameMinted: Number(totals?.minted ?? 0),
  };
  const holdings = s.pool + s.inStocks + s.inWallets + s.riding + s.inTournaments;
  return { ...s, drift: holdings - s.issued };
}

/** Player wallets whose stored balance differs from the sum of their ledger rows. */
export async function walletDrift(db: DbOrTx, clubId: string): Promise<{ checked: number; driftingCount: number; worstDriftCents: number }> {
  const rows = await db.execute<{ stored: string; computed: string }>(sql`
    select a.balance_cents as stored,
      coalesce((select sum(amount_cents) from ledger_entries where to_account_id = a.id), 0)
      - coalesce((select sum(amount_cents) from ledger_entries where from_account_id = a.id), 0) as computed
    from point_accounts a where a.club_id = ${clubId} and a.kind = 'player'`);
  const list = (rows as unknown as { rows?: { stored: string; computed: string }[] }).rows ?? (rows as unknown as { stored: string; computed: string }[]);
  const drifts = list.map((r) => Math.abs(Number(r.stored) - Number(r.computed))).filter((d) => d !== 0);
  return { checked: list.length, driftingCount: drifts.length, worstDriftCents: Math.max(0, ...drifts) };
}
