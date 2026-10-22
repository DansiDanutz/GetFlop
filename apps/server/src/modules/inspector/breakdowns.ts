import { and, count, eq, gte, inArray, lt, ne, sum } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { clubTables, ledgerEntries, pointAccounts } from '../../db/schema/index.js';
import { groupBy, totals, weightedTheoHold, type Totals } from './metrics.js';
import { roomNames, userNames, type BetRowFact } from './queries.js';
import type { Range } from './time.js';

export const POINTS_IN_KINDS = ['deposit', 'reload'] as const;
export const POINTS_OUT_KINDS = ['withdrawal', 'cashout'] as const;
export const TOURNAMENT_COLLECT_KINDS = ['tournament_buyin', 'tournament_fee', 'tournament_rebuy', 'tournament_addon'] as const;
export const REFUND_KINDS = ['coupon_voided', 'coupon_leg_cancelled', 'bet_refunded', 'coupon_refund'] as const;

/** Σ amount per ledger kind in a range (and the row count). */
export async function ledgerByKind(db: DbOrTx, clubId: string, range: Range, kinds: readonly string[]) {
  const rows = await db.select({ kind: ledgerEntries.kind, total: sum(ledgerEntries.amountCents), n: count() }).from(ledgerEntries)
    .where(and(eq(ledgerEntries.clubId, clubId), inArray(ledgerEntries.kind, [...kinds]),
      gte(ledgerEntries.createdAt, range.from), lt(ledgerEntries.createdAt, range.to)))
    .groupBy(ledgerEntries.kind);
  const byKind = new Map(rows.map((r) => [r.kind, { cents: Number(r.total ?? 0), n: r.n }]));
  const cents = (...ks: string[]) => ks.reduce((s, k) => s + (byKind.get(k)?.cents ?? 0), 0);
  const rowsOf = (k: string) => byKind.get(k)?.n ?? 0;
  return { cents, rowsOf };
}

/** Points in / out per player in a range. */
async function movementsByUser(db: DbOrTx, clubId: string, range: Range) {
  const rows = await db.select({ userId: ledgerEntries.userId, kind: ledgerEntries.kind, total: sum(ledgerEntries.amountCents) })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.clubId, clubId), inArray(ledgerEntries.kind, [...POINTS_IN_KINDS, ...POINTS_OUT_KINDS]),
      gte(ledgerEntries.createdAt, range.from), lt(ledgerEntries.createdAt, range.to)))
    .groupBy(ledgerEntries.userId, ledgerEntries.kind);
  const out = new Map<string, { inCents: number; outCents: number }>();
  for (const r of rows) {
    if (!r.userId) continue;
    const prev = out.get(r.userId) ?? { inCents: 0, outCents: 0 };
    const amount = Number(r.total ?? 0);
    const isIn = (POINTS_IN_KINDS as readonly string[]).includes(r.kind);
    out.set(r.userId, isIn ? { ...prev, inCents: prev.inCents + amount } : { ...prev, outCents: prev.outCents + amount });
  }
  return out;
}

export async function walletBalances(db: DbOrTx, clubId: string): Promise<Map<string, number>> {
  const rows = await db.select({ userId: pointAccounts.userId, balance: pointAccounts.balanceCents }).from(pointAccounts)
    .where(and(eq(pointAccounts.clubId, clubId), eq(pointAccounts.kind, 'player')));
  return new Map(rows.filter((r) => r.userId).map((r) => [r.userId!, r.balance]));
}

export interface Line extends Totals { readonly theoHoldPct: number | null }

const line = (bets: readonly BetRowFact[]): Line => ({ ...totals(bets), theoHoldPct: weightedTheoHold(bets) });

/** Per table, idle tables included (non-archived ones with no play show zeroes). */
export async function byTable(db: DbOrTx, clubId: string, bets: readonly BetRowFact[], tableIds?: readonly string[]) {
  const conditions = [eq(clubTables.clubId, clubId), ne(clubTables.status, 'archived')];
  if (tableIds && tableIds.length > 0) conditions.push(inArray(clubTables.id, [...tableIds]));
  const tables = await db.select({ id: clubTables.id, name: clubTables.name, kind: clubTables.kind, roomId: clubTables.roomId })
    .from(clubTables).where(and(...conditions));
  const grouped = groupBy(bets, (b) => b.tableId);
  const known = new Map(tables.map((t) => [t.id, t]));
  for (const b of bets) if (!known.has(b.tableId)) known.set(b.tableId, { id: b.tableId, name: b.tableName, kind: b.tableKind, roomId: b.roomId });
  return [...known.values()]
    .map((t) => ({ tableId: t.id, name: t.name, kind: t.kind, idle: !grouped.has(t.id), ...line(grouped.get(t.id) ?? []) }))
    .sort((a, b) => b.handleCents - a.handleCents || a.name.localeCompare(b.name));
}

export async function byRoom(db: DbOrTx, clubId: string, bets: readonly BetRowFact[]) {
  const names = await roomNames(db, clubId);
  return [...groupBy(bets, (b) => b.roomId).entries()]
    .map(([roomId, list]) => ({ roomId, name: roomId ? names.get(roomId) ?? '' : null, ...line(list) }))
    .sort((a, b) => b.handleCents - a.handleCents);
}

/** Per player: played, won, club result, Points in/out in the range and current balance. */
export async function byPlayer(db: DbOrTx, clubId: string, bets: readonly BetRowFact[], range: Range) {
  const moves = await movementsByUser(db, clubId, range);
  const balances = await walletBalances(db, clubId);
  const grouped = groupBy(bets, (b) => b.userId);
  const ids = [...new Set([...grouped.keys(), ...moves.keys()])];
  const names = await userNames(db, ids);
  return ids.map((userId) => {
    const t = totals(grouped.get(userId) ?? []);
    return {
      userId, name: names.get(userId) ?? '', picks: t.picks, playedCents: t.handleCents, wonCents: t.paidCents,
      resultCents: t.resultCents, inCents: moves.get(userId)?.inCents ?? 0, outCents: moves.get(userId)?.outCents ?? 0,
      balanceCents: balances.get(userId) ?? 0,
    };
  }).sort((a, b) => b.playedCents - a.playedCents || a.name.localeCompare(b.name));
}

/** Tournament money in Points for a range (entries, collected, prizes). */
export async function tournamentFigures(db: DbOrTx, clubId: string, range: Range) {
  const l = await ledgerByKind(db, clubId, range, [...TOURNAMENT_COLLECT_KINDS, 'tournament_refund', 'tournament_payout']);
  const collectedCents = l.cents(...TOURNAMENT_COLLECT_KINDS) - l.cents('tournament_refund');
  const prizesCents = l.cents('tournament_payout');
  return {
    entries: l.rowsOf('tournament_buyin'),
    buyinsCents: l.cents('tournament_buyin', 'tournament_fee'),
    rebuysCents: l.cents('tournament_rebuy'),
    addonsCents: l.cents('tournament_addon'),
    refundsCents: l.cents('tournament_refund'),
    collectedCents, prizesCents, resultCents: collectedCents - prizesCents,
  };
}
