import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { Tx } from '../../db/client.js';
import { clubTables } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { can, type ClubAccess } from '../clubs/access.js';
import { heldTable, seatInTx } from '../game/dealer.js';
import { emitTableChanged, liveHand, type TableRow } from '../game/tables.js';
import { announceNewRequest, createSitRequestTx, type SitRequestView } from './sitRequests.js';

export type SitResult =
  | { readonly status: 'seated'; readonly table: TableRow }
  | { readonly status: 'requested'; readonly request: SitRequestView };

/** Sitting needs the floor's approval when the club asks for it, unless the caller is the owner or a manager. */
export function needsApproval(access: ClubAccess): boolean {
  if (!access.club.dealerSitApproval || access.isAdmin) return false;
  return !access.roles.includes('owner') && !access.roles.includes('manager');
}

function assertDealer(access: ClubAccess): void {
  if (!can(access, 'deal')) throw new AppError('dealer.not_found', 403);
}

/** Seats now or stores a sit request, inside the caller's transaction. */
async function sitOrAskTx(tx: Tx, ctx: AppContext, access: ClubAccess, tableId: string) {
  if (needsApproval(access)) return { status: 'requested' as const, sitId: await createSitRequestTx(tx, ctx, access, tableId) };
  return { status: 'seated' as const, table: await seatInTx(tx, access.club.id, tableId, access.user.id) };
}

async function finish(ctx: AppContext, access: ClubAccess, tableId: string, out: Awaited<ReturnType<typeof sitOrAskTx>>): Promise<SitResult> {
  if (out.status === 'requested') {
    return { status: 'requested', request: await announceNewRequest(ctx, access.club.id, out.sitId, tableId) };
  }
  emitTableChanged(ctx, out.table);
  return { status: 'seated', table: out.table };
}

/** POST /dealer/table/:id/sit */
export async function sitOrAsk(ctx: AppContext, access: ClubAccess, tableId: string): Promise<SitResult> {
  assertDealer(access);
  const out = await ctx.db.transaction((tx) => sitOrAskTx(tx, ctx, access, tableId));
  return finish(ctx, access, tableId, out);
}

/** Stands the dealer up from their held table inside a transaction. Live hands block it. */
async function standUpHeldTx(tx: Tx, dealerId: string, heldTableId: string, fromClubId: string | null): Promise<TableRow> {
  const held = await heldTable(tx, dealerId);
  if (!held || held.table.id !== heldTableId) throw new AppError('dealer.switch_stale', 409);
  const [locked] = await tx.select().from(clubTables).where(eq(clubTables.id, heldTableId)).limit(1).for('update');
  if (!locked || locked.dealerId !== dealerId) throw new AppError('dealer.switch_stale', 409);
  const hand = await liveHand(tx, heldTableId);
  if (hand) {
    if (fromClubId === locked.clubId) throw new AppError('dealer.hand_live', 409, { hand: hand.handNumber });
    throw new AppError('dealer.held_hand_live', 409, { table: locked.name, club: held.clubName });
  }
  const [freed] = await tx.update(clubTables).set({ dealerId: null }).where(eq(clubTables.id, heldTableId)).returning();
  return freed!;
}

/** POST /dealer/table/:id/switch — leave the held table and sit (or ask to sit) here, in one step. */
export async function switchTable(ctx: AppContext, access: ClubAccess, tableId: string, heldTableId: string): Promise<SitResult> {
  assertDealer(access);
  const { freed, out } = await ctx.db.transaction(async (tx) => {
    const freedTable = await standUpHeldTx(tx, access.user.id, heldTableId, access.club.id);
    return { freed: freedTable, out: await sitOrAskTx(tx, ctx, access, tableId) };
  });
  emitTableChanged(ctx, freed);
  return finish(ctx, access, tableId, out);
}

/** POST /dealer/held/leave — stand up from the held table (possibly in another club). */
export async function leaveHeld(ctx: AppContext, dealerId: string): Promise<{ table: string; club: string }> {
  const held = await heldTable(ctx.db, dealerId);
  if (!held) throw new AppError('dealer.not_dealing', 403);
  const freed = await ctx.db.transaction(async (tx) => {
    const hand = await liveHand(tx, held.table.id);
    if (hand) throw new AppError('dealer.held_hand_live', 409, { table: held.table.name, club: held.clubName });
    return standUpHeldTx(tx, dealerId, held.table.id, null);
  });
  emitTableChanged(ctx, freed);
  return { table: held.table.name, club: held.clubName };
}
