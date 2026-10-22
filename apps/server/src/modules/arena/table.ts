import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { hands } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { AuthUser } from '../auth/session.js';
import { can, loadClubAccess, type ClubAccess } from '../clubs/access.js';
import { placeCoupon, type PlaceCouponInput } from '../game/coupons.js';
import { publicHand } from '../game/hands.js';
import { catalogue, marketList, offeredAt } from '../game/markets.js';
import { getTable, type TableRow } from '../game/tables.js';
import { dealClock, openArenaTables, tableState, tickTable } from './autodeal.js';
import { arenaConfig, dealSeconds } from './config.js';
import { assertOpen, requirePlayer, touchPresence } from './players.js';
import { ARENA_KIND, ensureArena } from './setup.js';
import { starBalance } from './stars.js';

const RECENT_HANDS = 10;

/** An Arena table as the player app shows it, with its live deal clock. */
export async function arenaTableView(ctx: AppContext, table: TableRow) {
  const cfg = arenaConfig();
  const now = ctx.now();
  const state = await tableState(ctx.db, table.id, now, cfg);
  const cat = await catalogue(ctx.db);
  const [last] = await ctx.db.select().from(hands)
    .where(and(eq(hands.tableId, table.id), eq(hands.status, 'settled'))).orderBy(desc(hands.handNumber)).limit(1);
  return {
    id: table.id, name: table.name, kind: table.kind, status: table.status, unit: 'stars' as const, isAutoDeal: table.isAutoDeal,
    limits: { minCents: table.limits.minCents, maxRounds: table.limits.maxRounds },
    offered: marketList(cat, offeredAt(table.markets, cat)),
    currentHand: state.live ? publicHand(state.live) : null,
    lastHand: last ? publicHand(last) : null,
    awake: state.awake,
    dealClock: dealClock(state, now, cfg),
    dealSeconds: dealSeconds(cfg),
  };
}

async function arenaTable(ctx: AppContext, tableId: string): Promise<TableRow> {
  const { clubId } = await ensureArena(ctx);
  const table = await getTable(ctx.db, clubId, tableId).catch(() => { throw new AppError('arena.not_a_club', 404); });
  if (table.kind !== ARENA_KIND) throw new AppError('arena.not_a_club', 404);
  return table;
}

export async function listTables(ctx: AppContext) {
  const { clubId } = await ensureArena(ctx);
  const tables = await openArenaTables(ctx.db, clubId);
  return { tables: await Promise.all(tables.map((t) => arenaTableView(ctx, t))), dealSeconds: dealSeconds(arenaConfig()) };
}

/** Sitting down keeps the table awake; an asleep table deals at once. */
export async function sit(ctx: AppContext, user: AuthUser, tableId: string) {
  assertOpen();
  const table = await arenaTable(ctx, tableId);
  await requirePlayer(ctx.db, user.id);
  await touchPresence(ctx, user.id, table.id);
  await tickTable(ctx, table);
  const access = await loadClubAccess(ctx.db, user, table.clubId);
  return {
    table: await arenaTableView(ctx, table),
    balanceCents: await starBalance(ctx.db, user.id),
    canPlay: can(access, 'play'),
  };
}

export async function arenaAccess(ctx: AppContext, user: AuthUser): Promise<ClubAccess> {
  const { clubId } = await ensureArena(ctx);
  await requirePlayer(ctx.db, user.id);
  return loadClubAccess(ctx.db, user, clubId);
}

/** Places a Stars coupon (no per-pick maximum, no coupon cap, no per-market cap). */
export async function placeArenaCoupon(ctx: AppContext, user: AuthUser, input: PlaceCouponInput) {
  assertOpen();
  const table = await arenaTable(ctx, input.tableId);
  const access = await arenaAccess(ctx, user);
  // Wake the table first, so a coupon placed on a sleeping table plays the hand it starts.
  await touchPresence(ctx, user.id, table.id);
  await tickTable(ctx, table);
  return placeCoupon(ctx, access, input);
}

export async function recentHands(ctx: AppContext, tableId: string) {
  const table = await arenaTable(ctx, tableId);
  const rows = await ctx.db.select().from(hands)
    .where(and(eq(hands.tableId, table.id), inArray(hands.status, ['settled', 'cancelled'])))
    .orderBy(desc(hands.handNumber)).limit(RECENT_HANDS);
  return { hands: rows.map(publicHand) };
}
