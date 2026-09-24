import { DEFAULT_LIMITS, MARKETS, validateLimits } from '@getflop/engine';
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx, Tx } from '../../db/client.js';
import { clubTables, couponLegs, coupons, hands, type TableLimitsJson } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { assertName } from '../auth/validation.js';
import { can, type ClubAccess } from '../clubs/access.js';
import { levelOf, nextLevel } from '../commerce/levels.js';
import { move, RIDING, wallet } from '../points/ledger.js';

export type TableRow = typeof clubTables.$inferSelect;
export const LIVE_HAND: readonly string[] = ['betting_open', 'betting_closed'];

export async function getTable(db: DbOrTx, clubId: string, tableId: string, lock = false): Promise<TableRow> {
  const q = db.select().from(clubTables).where(and(eq(clubTables.id, tableId), eq(clubTables.clubId, clubId))).limit(1);
  const [table] = lock ? await q.for('update') : await q;
  if (!table || table.status === 'archived') throw new AppError('table.not_found', 404);
  return table;
}

export async function liveHand(db: DbOrTx, tableId: string) {
  const [hand] = await db.select().from(hands)
    .where(and(eq(hands.tableId, tableId), inArray(hands.status, ['betting_open', 'betting_closed']))).limit(1);
  return hand ?? null;
}

export interface TableInput {
  readonly name?: string;
  readonly game?: 'nlh' | 'plo' | 'other';
  readonly photoUrl?: string | null;
  readonly featured?: boolean;
  readonly roomId?: string | null;
}

export async function createTable(ctx: AppContext, access: ClubAccess, input: TableInput & { name: string }): Promise<TableRow> {
  if (!can(access, 'tables.edit')) throw new AppError('club.capability_missing', 403);
  const name = assertName(input.name, { min: 1, max: 40, code: 'table.name_invalid' });
  const [table] = await ctx.db.insert(clubTables).values({
    clubId: access.club.id, name, game: input.game ?? 'nlh', photoUrl: input.photoUrl ?? null,
    featured: input.featured ?? false, roomId: input.roomId ?? null, limits: { ...DEFAULT_LIMITS, marketMaxCents: {} },
  }).returning();
  ctx.events.emit(rooms.staff(access.club.id), 'floor:changed', { tableId: table!.id });
  return table!;
}

export async function updateTable(ctx: AppContext, access: ClubAccess, tableId: string, input: TableInput): Promise<TableRow> {
  if (!can(access, 'tables.edit')) throw new AppError('club.capability_missing', 403);
  await getTable(ctx.db, access.club.id, tableId);
  const patch: Partial<TableRow> = {};
  if (input.name !== undefined) patch.name = assertName(input.name, { min: 1, max: 40, code: 'table.name_invalid' });
  if (input.game !== undefined) patch.game = input.game;
  if (input.photoUrl !== undefined) patch.photoUrl = input.photoUrl;
  if (input.featured !== undefined) patch.featured = input.featured;
  if (input.roomId !== undefined) patch.roomId = input.roomId;
  const [table] = await ctx.db.update(clubTables).set(patch).where(eq(clubTables.id, tableId)).returning();
  emitTableChanged(ctx, table!);
  return table!;
}

/** Sets the markets a table offers. Empty = every active market. Live coupons on removed markets are left to finish. */
export async function setTableMarkets(ctx: AppContext, access: ClubAccess, tableId: string, slugs: string[]): Promise<TableRow> {
  if (!can(access, 'tables.edit')) throw new AppError('club.capability_missing', 403);
  const known = new Set(MARKETS.map((m) => m.slug));
  if (slugs.some((s) => !known.has(s))) throw new AppError('table.market_unknown');
  const table = await getTable(ctx.db, access.club.id, tableId);
  if (table.kind === 'tournament') throw new AppError('table.markets_tournament');
  const [updated] = await ctx.db.update(clubTables).set({ markets: [...new Set(slugs)] }).where(eq(clubTables.id, tableId)).returning();
  emitTableChanged(ctx, updated!);
  return updated!;
}

export async function setTableLimits(ctx: AppContext, access: ClubAccess, tableId: string, limits: TableLimitsJson): Promise<TableRow> {
  if (!can(access, 'limits.edit')) throw new AppError('limits.owner_only', 403);
  const table = await getTable(ctx.db, access.club.id, tableId);
  if (table.kind === 'tournament') throw new AppError('table.limits_tournament');
  const error = validateLimits(limits);
  if (error) throw new AppError(`table.${error}`, 400, { min: limits.minCents });
  const [updated] = await ctx.db.update(clubTables).set({ limits }).where(eq(clubTables.id, tableId)).returning();
  emitTableChanged(ctx, updated!);
  return updated!;
}

async function openRingGames(db: DbOrTx, clubId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(clubTables)
    .where(and(eq(clubTables.clubId, clubId), eq(clubTables.status, 'open'), eq(clubTables.kind, 'cash')));
  return row?.n ?? 0;
}

export async function openTable(ctx: AppContext, access: ClubAccess, tableId: string, dealerId?: string | null): Promise<TableRow> {
  if (!can(access, 'floor')) throw new AppError('club.capability_missing', 403);
  const table = await getTable(ctx.db, access.club.id, tableId);
  if (table.status === 'open') return table;
  if (table.kind === 'cash') {
    const level = levelOf(access.club.level);
    const used = await openRingGames(ctx.db, access.club.id);
    if (used >= level.ringGames) {
      throw new AppError(can(access, 'billing') ? 'commerce.capacity_ring_games_billing' : 'commerce.capacity_ring_games_staff', 409, {
        used, limit: level.ringGames, nextLevel: nextLevel(level.code)?.name ?? '',
      });
    }
  }
  const [updated] = await ctx.db.update(clubTables).set({ status: 'open', ...(dealerId ? { dealerId } : {}) })
    .where(eq(clubTables.id, tableId)).returning();
  emitTableChanged(ctx, updated!);
  return updated!;
}

export interface ClosePreview {
  readonly hasActiveHand: boolean;
  readonly liveCoupons: number;
  readonly refundCents: number;
}

async function unplayedByCoupon(db: DbOrTx, tableId: string) {
  const live = await db.select().from(coupons).where(and(eq(coupons.tableId, tableId), eq(coupons.status, 'live')));
  if (live.length === 0) return [];
  const legs = await db.select().from(couponLegs)
    .where(and(inArray(couponLegs.couponId, live.map((c) => c.id)), eq(couponLegs.status, 'active')));
  return live.map((c) => {
    const perRound = legs.filter((l) => l.couponId === c.id).reduce((s, l) => s + l.stakeCents, 0);
    return { coupon: c, refundCents: perRound * (c.rounds - c.roundsSettled) };
  });
}

export async function closePreview(ctx: AppContext, access: ClubAccess, tableId: string): Promise<ClosePreview> {
  await getTable(ctx.db, access.club.id, tableId);
  const list = await unplayedByCoupon(ctx.db, tableId);
  return {
    hasActiveHand: Boolean(await liveHand(ctx.db, tableId)),
    liveCoupons: list.length,
    refundCents: list.reduce((s, x) => s + x.refundCents, 0),
  };
}

/** Voids every live coupon on a table, refunding unplayed rounds to wallets. */
export async function voidLiveCoupons(ctx: AppContext, tx: Tx, clubId: string, tableId: string, actorId: string | null) {
  const list = await unplayedByCoupon(tx, tableId);
  for (const { coupon, refundCents } of list) {
    if (refundCents > 0) {
      await move(tx, {
        clubId, kind: 'coupon_voided', from: RIDING, to: wallet(coupon.userId), amountCents: refundCents,
        actorId, refType: 'coupon', refId: coupon.id,
      });
    }
    await tx.update(coupons).set({ status: 'voided', refundedCents: coupon.refundedCents + refundCents, finishedAt: ctx.now() })
      .where(eq(coupons.id, coupon.id));
  }
  return list;
}

export async function closeTable(ctx: AppContext, access: ClubAccess, tableId: string): Promise<ClosePreview> {
  if (!can(access, 'floor')) throw new AppError('club.capability_missing', 403);
  const clubId = access.club.id;
  const result = await ctx.db.transaction(async (tx) => {
    const table = await getTable(tx, clubId, tableId, true);
    const hand = await liveHand(tx, tableId);
    if (hand) throw new AppError('table.hand_live', 409, { hand: hand.handNumber });
    const voided = await voidLiveCoupons(ctx, tx, clubId, tableId, access.user.id);
    await tx.update(clubTables).set({ status: 'closed', dealerId: null }).where(eq(clubTables.id, table.id));
    return voided;
  });
  for (const { coupon, refundCents } of result) {
    ctx.events.emit(rooms.user(coupon.userId), 'coupon:voided', {
      couponId: coupon.id, tableId, refundCents, roundsUnresolved: coupon.rounds - coupon.roundsSettled,
    });
  }
  ctx.events.emit(rooms.table(tableId), 'table:closed', { tableId });
  ctx.events.emit(rooms.staff(clubId), 'floor:changed', { tableId });
  return { hasActiveHand: false, liveCoupons: result.length, refundCents: result.reduce((s, x) => s + x.refundCents, 0) };
}

export function emitTableChanged(ctx: AppContext, table: TableRow): void {
  ctx.events.emit(rooms.table(table.id), 'table:updated', { tableId: table.id });
  ctx.events.emit(rooms.staff(table.clubId), 'floor:changed', { tableId: table.id });
}

export async function clubTablesList(db: DbOrTx, clubId: string, opts: { includeClosed?: boolean } = {}) {
  const conditions = [eq(clubTables.clubId, clubId), ne(clubTables.status, 'archived')];
  if (!opts.includeClosed) conditions.push(eq(clubTables.status, 'open'));
  return db.select().from(clubTables).where(and(...conditions)).orderBy(clubTables.createdAt);
}
