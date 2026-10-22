import { and, count, eq, inArray, max, ne } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { clubTables, couponLegs, coupons, hands, memberships, pointRequests, rooms } from '../../db/schema/index.js';
import type { ClubAccess } from '../clubs/access.js';
import { walletDrift } from '../points/ledger.js';
import { budgetState } from './budget.js';
import { buildAlerts, classifyTable, GROUP_ORDER, type DriftResult, type FloorGroup, type FloorRow } from './floor.js';
import { clubTournaments, isLevelLocked, isSimulationClub, userNames } from './queries.js';

type TableRow = typeof clubTables.$inferSelect;

async function countsByTable(db: DbOrTx, tableIds: string[]) {
  if (tableIds.length === 0) return { handCount: new Map<string, number>(), settledAt: new Map<string, Date>() };
  const rows = await db.select({ tableId: hands.tableId, n: count(), last: max(hands.settledAt) }).from(hands)
    .where(and(inArray(hands.tableId, tableIds), eq(hands.status, 'settled'))).groupBy(hands.tableId);
  return {
    handCount: new Map(rows.map((r) => [r.tableId, r.n])),
    settledAt: new Map(rows.filter((r) => r.last).map((r) => [r.tableId, new Date(r.last!)])),
  };
}

async function liveHands(db: DbOrTx, tableIds: string[]) {
  if (tableIds.length === 0) return new Map<string, { status: string; handNumber: number }>();
  const rows = await db.select({ tableId: hands.tableId, status: hands.status, handNumber: hands.handNumber }).from(hands)
    .where(and(inArray(hands.tableId, tableIds), inArray(hands.status, ['betting_open', 'betting_closed'])));
  return new Map(rows.map((r) => [r.tableId, r]));
}

/** Live coupons per table and the Points still riding on them (unplayed rounds). */
export async function exposureByTable(db: DbOrTx, tableIds: string[]) {
  const out = new Map<string, { coupons: number; exposureCents: number }>();
  if (tableIds.length === 0) return out;
  const live = await db.select().from(coupons).where(and(inArray(coupons.tableId, tableIds), eq(coupons.status, 'live')));
  if (live.length === 0) return out;
  const legs = await db.select({ couponId: couponLegs.couponId, stake: couponLegs.stakeCents }).from(couponLegs)
    .where(and(inArray(couponLegs.couponId, live.map((c) => c.id)), eq(couponLegs.status, 'active')));
  for (const c of live) {
    const perRound = legs.filter((l) => l.couponId === c.id).reduce((s, l) => s + l.stake, 0);
    const prev = out.get(c.tableId) ?? { coupons: 0, exposureCents: 0 };
    out.set(c.tableId, { coupons: prev.coupons + 1, exposureCents: prev.exposureCents + perRound * (c.rounds - c.roundsSettled) });
  }
  return out;
}

async function simulationRoomIds(db: DbOrTx, clubId: string): Promise<Set<string>> {
  const rows = await db.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.clubId, clubId), eq(rooms.name, 'Simulation')));
  return new Set(rows.map((r) => r.id));
}

export interface FloorTableView extends FloorRow {
  readonly group: FloorGroup;
  readonly roomId: string | null;
  readonly joinCode: string;
  readonly game: string;
  readonly featured: boolean;
  readonly tournamentId: string | null;
  readonly tournamentName: string | null;
  readonly tournamentStatus: string | null;
  readonly tournamentScheduledAt: Date | null;
}

/** Every non-archived table of the club, enriched for the floor. */
export async function floorRows(ctx: AppContext, access: ClubAccess): Promise<FloorTableView[]> {
  const clubId = access.club.id;
  const tables: TableRow[] = await ctx.db.select().from(clubTables)
    .where(and(eq(clubTables.clubId, clubId), ne(clubTables.status, 'archived'))).orderBy(clubTables.createdAt);
  const ids = tables.map((t) => t.id);
  const [counts, live, exposure, names, simRooms, tournaments] = await Promise.all([
    countsByTable(ctx.db, ids), liveHands(ctx.db, ids), exposureByTable(ctx.db, ids),
    userNames(ctx.db, tables.map((t) => t.dealerId)), simulationRoomIds(ctx.db, clubId),
    clubTournaments(ctx.db, clubId, tables.map((t) => t.tournamentId).filter((x): x is string => Boolean(x))),
  ]);
  const simClub = isSimulationClub(access.club);
  const now = ctx.now();
  return tables.map((t) => {
    const hand = live.get(t.id);
    const trn = t.tournamentId ? tournaments.find((x) => x.id === t.tournamentId) : undefined;
    const row: FloorRow = {
      id: t.id, name: t.name, kind: t.kind, status: t.status, dealerId: t.dealerId,
      dealerName: t.dealerId ? names.get(t.dealerId) ?? null : null, isAutoDeal: t.isAutoDeal,
      isSimulation: simClub || (t.roomId !== null && simRooms.has(t.roomId)), createdAt: t.createdAt,
      lastHandAt: counts.settledAt.get(t.id) ?? t.lastHandAt, totalHands: counts.handCount.get(t.id) ?? 0,
      activeHandStatus: hand?.status ?? null, activeHandNumber: hand?.handNumber ?? null,
      liveCoupons: exposure.get(t.id)?.coupons ?? 0, couponExposureCents: exposure.get(t.id)?.exposureCents ?? 0,
    };
    return {
      ...row, group: classifyTable(row, now), roomId: t.roomId, joinCode: t.joinCode, game: t.game, featured: t.featured,
      tournamentId: t.tournamentId, tournamentName: trn?.name ?? null, tournamentStatus: trn?.status ?? null,
      tournamentScheduledAt: trn?.scheduledAt ?? null,
    };
  });
}

async function driftOrUnknown(ctx: AppContext, clubId: string): Promise<DriftResult> {
  try {
    const d = await walletDrift(ctx.db, clubId);
    return { ok: true, driftingCount: d.driftingCount, worstDriftCents: d.worstDriftCents };
  } catch (err) {
    ctx.logger.error('Wallet drift check failed', err);
    return { ok: false };
  }
}

async function pendingCounts(db: DbOrTx, clubId: string) {
  const [points] = await db.select({ n: count() }).from(pointRequests)
    .where(and(eq(pointRequests.clubId, clubId), eq(pointRequests.status, 'pending')));
  const [joins] = await db.select({ n: count() }).from(memberships)
    .where(and(eq(memberships.clubId, clubId), eq(memberships.status, 'pending')));
  return { points: points?.n ?? 0, joins: joins?.n ?? 0 };
}

/** GET /inspector/dashboard: stats, grouped tables and the attention list. */
export async function dashboard(ctx: AppContext, access: ClubAccess) {
  const clubId = access.club.id;
  const now = ctx.now();
  const [rows, pending, drift, budget, tournaments] = await Promise.all([
    floorRows(ctx, access), pendingCounts(ctx.db, clubId), driftOrUnknown(ctx, clubId), budgetState(ctx.db),
    clubTournaments(ctx.db, clubId),
  ]);
  const hasAuto = rows.some((r) => r.isAutoDeal && r.status === 'open');
  const alerts = buildAlerts({
    levelLocked: isLevelLocked(access.club),
    pendingPoints: pending.points,
    simBudgetTripped: budget.tripped && (hasAuto || isSimulationClub(access.club)),
    drift,
    rows,
    tournaments: tournaments
      .filter((t) => t.status === 'upcoming' && t.scheduledAt)
      .map((t) => ({ id: t.id, name: t.name, scheduledAt: t.scheduledAt! })),
    now,
  });
  const open = rows.filter((r) => r.status === 'open');
  return {
    stats: {
      openTables: open.length,
      dealing: rows.filter((r) => r.group === 'dealing' || (r.group === 'auto' && r.activeHandStatus)).length,
      liveCoupons: rows.reduce((s, r) => s + r.liveCoupons, 0),
      exposureCents: rows.reduce((s, r) => s + r.couponExposureCents, 0),
      pendingPoints: pending.points,
      pendingJoins: pending.joins,
      levelLocked: isLevelLocked(access.club),
    },
    alerts,
    allClear: alerts.length === 0,
    groups: GROUP_ORDER.map((g) => ({ group: g, tableIds: rows.filter((r) => r.group === g).map((r) => r.id) })),
    tables: rows,
    serverTime: now,
  };
}
