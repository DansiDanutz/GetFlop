import { and, count, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { clubTables, clubs, coupons } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { can, type ClubAccess } from '../clubs/access.js';
import { emitTableChanged, getTable, liveHand } from './tables.js';

/** The table this user is dealing anywhere (a dealer holds one table across all clubs). */
export async function heldTable(db: DbOrTx, userId: string) {
  const [row] = await db.select({ table: clubTables, clubName: clubs.name }).from(clubTables)
    .innerJoin(clubs, eq(clubs.id, clubTables.clubId))
    .where(and(eq(clubTables.dealerId, userId), inArray(clubTables.status, ['open', 'closed']))).limit(1);
  return row ?? null;
}

export async function seatDealer(ctx: AppContext, clubId: string, tableId: string, dealerId: string) {
  return ctx.db.transaction(async (tx) => {
    const table = await getTable(tx, clubId, tableId, true);
    if (table.isAutoDeal) throw new AppError('dealer.auto_table');
    if (table.status !== 'open' || (table.dealerId && table.dealerId !== dealerId)) {
      throw new AppError('dealer.table_taken', 409, { table: table.name });
    }
    const held = await heldTable(tx, dealerId);
    if (held && held.table.id !== tableId) {
      throw new AppError(held.table.clubId === clubId ? 'dealer.holds_other' : 'dealer.you_deal_elsewhere', 409, {
        table: held.table.name, club: held.clubName,
      });
    }
    const [own] = await tx.select({ n: count() }).from(coupons)
      .where(and(eq(coupons.tableId, tableId), eq(coupons.userId, dealerId), eq(coupons.status, 'live')));
    if ((own?.n ?? 0) > 0) throw new AppError('dealer.own_live_coupons', 409, { n: own!.n, table: table.name });
    const [updated] = await tx.update(clubTables).set({ dealerId }).where(eq(clubTables.id, tableId)).returning();
    return updated!;
  });
}

/** A dealer sits at an open table with no dealer. */
export async function sit(ctx: AppContext, access: ClubAccess, tableId: string) {
  if (!can(access, 'deal')) throw new AppError('dealer.not_found', 403);
  const table = await seatDealer(ctx, access.club.id, tableId, access.user.id);
  emitTableChanged(ctx, table);
  return table;
}

/** Stand up: the table stays open without a dealer. */
export async function standUp(ctx: AppContext, clubId: string, tableId: string, dealerId: string, by: 'self' | 'floor') {
  const table = await ctx.db.transaction(async (tx) => {
    const t = await getTable(tx, clubId, tableId, true);
    if (t.dealerId !== dealerId) throw new AppError('dealer.not_dealing', 403);
    const hand = await liveHand(tx, tableId);
    if (hand) throw new AppError('dealer.hand_live', 409, { hand: hand.handNumber });
    const [updated] = await tx.update(clubTables).set({ dealerId: null }).where(eq(clubTables.id, tableId)).returning();
    return updated!;
  });
  if (by === 'floor') ctx.events.emit(rooms.user(dealerId), 'dealer:seat', { status: 'unseated', tableId, tableName: table.name });
  emitTableChanged(ctx, table);
  return table;
}
