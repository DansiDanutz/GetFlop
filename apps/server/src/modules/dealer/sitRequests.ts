import { and, asc, eq, type SQL } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx, Tx } from '../../db/client.js';
import { clubTables, clubs, dealerSitRequests, memberships, users, type DealerSitStatus } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import type { ClubAccess } from '../clubs/access.js';
import { assertNoOwnLiveCoupons, heldTable, seatInTx } from '../game/dealer.js';
import { emitTableChanged, getTable, type TableRow } from '../game/tables.js';

type SitRow = typeof dealerSitRequests.$inferSelect;

export interface SitRequestView {
  readonly id: string;
  readonly clubId: string;
  readonly clubName: string;
  readonly tableId: string;
  readonly tableName: string;
  readonly dealerId: string;
  readonly dealerName: string;
  readonly status: DealerSitStatus;
  readonly createdAt: Date;
}

/** Outcome of a floor decision. `taken`: the table got a dealer. `busy`: the dealer is dealing elsewhere now. */
export type SitDecision = 'approved' | 'rejected' | 'taken' | 'busy';

const requestView = () => ({
  id: dealerSitRequests.id, clubId: dealerSitRequests.clubId, clubName: clubs.name,
  tableId: dealerSitRequests.tableId, tableName: clubTables.name,
  dealerId: dealerSitRequests.dealerId, displayName: users.displayName, username: users.username,
  status: dealerSitRequests.status, createdAt: dealerSitRequests.createdAt,
});

type ViewRow = { displayName: string | null; username: string } & Omit<SitRequestView, 'dealerName'>;
const toView = ({ displayName, username, ...rest }: ViewRow): SitRequestView => ({ ...rest, dealerName: displayName ?? username });

function viewQuery(db: DbOrTx) {
  return db.select(requestView()).from(dealerSitRequests)
    .innerJoin(clubTables, eq(clubTables.id, dealerSitRequests.tableId))
    .innerJoin(clubs, eq(clubs.id, dealerSitRequests.clubId))
    .innerJoin(users, eq(users.id, dealerSitRequests.dealerId));
}

async function viewById(db: DbOrTx, id: string): Promise<SitRequestView> {
  const [row] = await viewQuery(db).where(eq(dealerSitRequests.id, id)).limit(1);
  if (!row) throw new AppError('club.request_not_found', 404);
  return toView(row);
}

/** The dealer's pending sit request in any club, or null. */
export async function pendingRequestOf(db: DbOrTx, dealerId: string): Promise<SitRequestView | null> {
  const [row] = await viewQuery(db)
    .where(and(eq(dealerSitRequests.dealerId, dealerId), eq(dealerSitRequests.status, 'pending'))).limit(1);
  return row ? toView(row) : null;
}

/** Pending requests of a club, oldest first (the floor's Requests page reads these as `dealerSits`). */
export async function pendingDealerSits(db: DbOrTx, clubId: string): Promise<SitRequestView[]> {
  const rows = await viewQuery(db)
    .where(and(eq(dealerSitRequests.clubId, clubId), eq(dealerSitRequests.status, 'pending')))
    .orderBy(asc(dealerSitRequests.createdAt));
  return rows.map(toView);
}

/** Validates like a sit and stores a pending request. Runs inside the caller's transaction. */
export async function createSitRequestTx(tx: Tx, ctx: AppContext, access: ClubAccess, tableId: string): Promise<string> {
  const dealerId = access.user.id;
  const [pending] = await tx.select({ id: dealerSitRequests.id }).from(dealerSitRequests)
    .where(and(eq(dealerSitRequests.dealerId, dealerId), eq(dealerSitRequests.status, 'pending'))).limit(1);
  if (pending) throw new AppError('dealer.request_pending', 409);
  const table = await getTable(tx, access.club.id, tableId, true);
  if (table.isAutoDeal) throw new AppError('dealer.auto_table');
  if (table.status !== 'open' || table.dealerId) throw new AppError('dealer.table_taken', 409, { table: table.name });
  const held = await heldTable(tx, dealerId);
  if (held) {
    throw new AppError(held.table.clubId === access.club.id ? 'dealer.holds_other' : 'dealer.you_deal_elsewhere', 409, {
      table: held.table.name, club: held.clubName,
    });
  }
  await assertNoOwnLiveCoupons(tx, table, dealerId);
  const [row] = await tx.insert(dealerSitRequests).values({ clubId: access.club.id, tableId, dealerId, createdAt: ctx.now() }).returning();
  return row!.id;
}

export async function announceNewRequest(ctx: AppContext, clubId: string, sitId: string, tableId: string): Promise<SitRequestView> {
  ctx.events.emit(rooms.staff(clubId), 'dealer-sit:new', { sitId, tableId });
  return viewById(ctx.db, sitId);
}

function announceResolved(ctx: AppContext, row: SitRow): void {
  ctx.events.emit(rooms.staff(row.clubId), 'dealer-sit:resolved', { sitId: row.id, tableId: row.tableId });
}

async function lockPending(tx: Tx, where: SQL | undefined): Promise<SitRow> {
  const [row] = await tx.select().from(dealerSitRequests).where(and(where, eq(dealerSitRequests.status, 'pending'))).limit(1).for('update');
  if (!row) throw new AppError('club.request_not_found', 404);
  return row;
}

/** The dealer withdraws their own pending request. */
export async function cancelSitRequest(ctx: AppContext, dealerId: string, sitId: string): Promise<SitRequestView> {
  const row = await ctx.db.transaction(async (tx) => {
    const found = await lockPending(tx, eq(dealerSitRequests.id, sitId));
    if (found.dealerId !== dealerId) throw new AppError('club.request_not_found', 404);
    const [updated] = await tx.update(dealerSitRequests).set({ status: 'cancelled', reviewedAt: ctx.now() })
      .where(eq(dealerSitRequests.id, sitId)).returning();
    return updated!;
  });
  announceResolved(ctx, row);
  return viewById(ctx.db, row.id);
}

async function decideApproval(tx: Tx, row: SitRow): Promise<{ decision: SitDecision; table: TableRow | null }> {
  const [m] = await tx.select({ roles: memberships.roles }).from(memberships)
    .where(and(eq(memberships.clubId, row.clubId), eq(memberships.userId, row.dealerId), eq(memberships.status, 'active')));
  if (!m?.roles.includes('dealer')) throw new AppError('dealer.not_found', 404);
  const [table] = await tx.select().from(clubTables).where(eq(clubTables.id, row.tableId)).limit(1).for('update');
  const taken = !table || table.isAutoDeal || table.status !== 'open' || (table.dealerId !== null && table.dealerId !== row.dealerId);
  if (taken) return { decision: 'taken', table: table ?? null };
  const held = await heldTable(tx, row.dealerId);
  if (held && held.table.id !== row.tableId) return { decision: 'busy', table };
  return { decision: 'approved', table: await seatInTx(tx, row.clubId, row.tableId, row.dealerId) };
}

/** Floor approves or rejects a pending request. Approval may close the request as taken or busy instead. */
export async function reviewSitRequest(
  ctx: AppContext, access: ClubAccess, sitId: string, verdict: 'approve' | 'reject',
): Promise<{ result: SitDecision; request: SitRequestView }> {
  const outcome = await ctx.db.transaction(async (tx) => {
    const row = await lockPending(tx, and(eq(dealerSitRequests.id, sitId), eq(dealerSitRequests.clubId, access.club.id)));
    const { decision, table } = verdict === 'reject' ? { decision: 'rejected' as const, table: null } : await decideApproval(tx, row);
    const [updated] = await tx.update(dealerSitRequests).set({ status: decision, reviewedBy: access.user.id, reviewedAt: ctx.now() })
      .where(eq(dealerSitRequests.id, sitId)).returning();
    return { decision, table, row: updated! };
  });
  const request = await viewById(ctx.db, sitId);
  const seatStatus = { approved: 'approved', rejected: 'rejected', taken: 'taken', busy: null }[outcome.decision];
  if (seatStatus) {
    ctx.events.emit(rooms.user(outcome.row.dealerId), 'dealer:seat', { status: seatStatus, tableId: request.tableId, tableName: request.tableName });
  }
  if (outcome.decision === 'approved' && outcome.table) emitTableChanged(ctx, outcome.table);
  announceResolved(ctx, outcome.row);
  return { result: outcome.decision, request };
}
