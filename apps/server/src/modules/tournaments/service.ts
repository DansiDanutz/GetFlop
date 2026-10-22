/** Staff controls: create (wizard), start, cancel, finish, pin, auto-deal (docs/spec/10 §1–3). */
import { and, count, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { Tx } from '../../db/client.js';
import { clubs, clubTables, memberships, tournamentEntries, tournaments } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { can, type ClubAccess } from '../clubs/access.js';
import { CLUB_LEVELS, levelOf, nextLevel } from '../commerce/levels.js';
import { heldTable } from '../game/dealer.js';
import { autoFlop } from '../game/hands.js';
import { activeSlugs } from '../game/markets.js';
import { getTable, liveHand } from '../game/tables.js';
import { ensureBots } from './bots.js';
import { cancelTournament, finishTournament } from './lifecycle.js';
import { emitFinished } from './progress.js';
import { resolveConfig, type TournamentConfig, type TournamentInput } from './rules.js';
import { emitTournament, getTournament, logEvent, TOURNAMENT_TABLE_LIMITS, type TournamentRow } from './store.js';

const TABLE_NAME_MAX = 40;
const BUSY: TournamentRow['status'][] = ['upcoming', 'active'];

/** Who acts: a staff member, or the server (auto start). */
export type Actor = ClubAccess | null;

function billingCode(actor: Actor, base: string): string {
  return `${base}_${actor && can(actor, 'billing') ? 'billing' : 'staff'}`;
}

export function assertLevelHasTournaments(clubLevel: string, actor: Actor): void {
  if (levelOf(clubLevel).tournaments > 0) return;
  const required = CLUB_LEVELS.find((l) => l.tournaments > 0)!;
  throw new AppError(billingCode(actor, 'commerce.level_tournaments_unavailable'), 409, { requiredLevel: required.name });
}

async function assertCapacity(tx: Tx, clubId: string, clubLevel: string, actor: Actor): Promise<void> {
  assertLevelHasTournaments(clubLevel, actor);
  const level = levelOf(clubLevel);
  const [row] = await tx.select({ n: count() }).from(tournaments).where(and(eq(tournaments.clubId, clubId), eq(tournaments.status, 'active')));
  const used = row?.n ?? 0;
  if (used >= level.tournaments) {
    throw new AppError(billingCode(actor, 'commerce.capacity_tournaments'), 409, { used, limit: level.tournaments, nextLevel: nextLevel(level.code)?.name ?? '' });
  }
}

async function assertDealer(tx: Tx, clubId: string, dealerId: string): Promise<void> {
  const [m] = await tx.select({ roles: memberships.roles }).from(memberships)
    .where(and(eq(memberships.clubId, clubId), eq(memberships.userId, dealerId), eq(memberships.status, 'active')));
  if (!m?.roles.includes('dealer')) throw new AppError('dealer.not_found', 404);
}

async function hostTable(tx: Tx, clubId: string, cfg: TournamentConfig, tableId: string | null | undefined) {
  if (!tableId) {
    const [created] = await tx.insert(clubTables).values({
      clubId, name: cfg.name.slice(0, TABLE_NAME_MAX), kind: 'tournament', status: 'closed',
      markets: [...cfg.markets], limits: TOURNAMENT_TABLE_LIMITS,
    }).returning();
    return created!;
  }
  const table = await getTable(tx, clubId, tableId, true);
  if (table.kind !== 'tournament') throw new AppError('table.not_found', 404);
  const [busy] = await tx.select({ id: tournaments.id }).from(tournaments)
    .where(and(eq(tournaments.tableId, table.id), inArray(tournaments.status, BUSY))).limit(1);
  if (busy || (await liveHand(tx, table.id))) throw new AppError('trm.table_busy', 409, { table: table.name });
  return table;
}

export async function createTournament(ctx: AppContext, access: ClubAccess, input: TournamentInput & { tableId?: string | null }) {
  assertLevelHasTournaments(access.club.level, access);
  const cfg = resolveConfig(input, new Set(await activeSlugs(ctx.db)));
  const clubId = access.club.id;
  const t = await ctx.db.transaction(async (tx) => {
    if (cfg.dealerId) await assertDealer(tx, clubId, cfg.dealerId);
    const table = await hostTable(tx, clubId, cfg, input.tableId);
    const [row] = await tx.insert(tournaments).values({
      ...cfg, markets: [...cfg.markets], levels: [...cfg.levels], payoutStructure: [...cfg.payoutStructure],
      clubId, tableId: table.id, createdBy: access.user.id, createdAt: ctx.now(),
    }).returning();
    await tx.update(clubTables).set({
      tournamentId: row!.id, markets: [...cfg.markets], limits: TOURNAMENT_TABLE_LIMITS, isAutoDeal: false,
      autoDealSeconds: cfg.autoDealSeconds,
    }).where(eq(clubTables.id, table.id));
    await logEvent(tx, row!.id, 'created', { by: access.user.username });
    return row!;
  });
  emitTournament(ctx, t, 'tournament:created');
  ctx.events.emit(rooms.staff(clubId), 'floor:changed', { tableId: t.tableId });
  return t;
}

export async function startTournament(ctx: AppContext, actor: Actor, tournamentId: string): Promise<TournamentRow> {
  const result = await ctx.db.transaction(async (tx) => {
    const t = await getTournament(tx, tournamentId, true);
    if (t.status === 'active') return { t, started: false };
    if (t.status !== 'upcoming') throw new AppError('trm.not_active', 409);
    const [club] = actor ? [actor.club] : await tx.select({ level: clubs.level }).from(clubs).where(eq(clubs.id, t.clubId));
    await assertCapacity(tx, t.clubId, club!.level, actor);
    if (t.dealerId) {
      const held = await heldTable(tx, t.dealerId);
      if (held && held.table.id !== t.tableId) throw new AppError('dealer.busy_elsewhere', 409, { table: held.table.name });
    }
    if (t.botsAllowed) await ensureBots(ctx, tx, t);
    await tx.update(tournamentEntries).set({ status: 'active', chips: t.startingStack, registeredAtHand: 0 })
      .where(and(eq(tournamentEntries.tournamentId, t.id), eq(tournamentEntries.status, 'registered')));
    await tx.update(clubTables).set({
      status: 'open', dealerId: t.dealerId, isAutoDeal: t.autoDealSeconds !== null, autoDealSeconds: t.autoDealSeconds,
      markets: t.markets, limits: TOURNAMENT_TABLE_LIMITS, tournamentId: t.id,
    }).where(eq(clubTables.id, t.tableId));
    const [started] = await tx.update(tournaments).set({ status: 'active', startedAt: ctx.now(), handsPlayed: 0, currentLevel: 1 })
      .where(eq(tournaments.id, t.id)).returning();
    await logEvent(tx, t.id, 'started', { by: actor ? actor.user.username : 'auto' });
    const entrants = await tx.select({ userId: tournamentEntries.userId }).from(tournamentEntries)
      .where(and(eq(tournamentEntries.tournamentId, t.id), eq(tournamentEntries.status, 'active')));
    return { t: started!, started: true, entrants: entrants.map((e) => e.userId) };
  });
  const t = result.t;
  if (!result.started) return t;
  emitTournament(ctx, t, 'tournament:started', { tableId: t.tableId });
  for (const userId of result.entrants ?? []) {
    ctx.events.emit(rooms.user(userId), 'tournament:started', { tournamentId: t.id, tableId: t.tableId, chips: t.startingStack });
  }
  if (t.dealerId) {
    const table = await getTable(ctx.db, t.clubId, t.tableId);
    ctx.events.emit(rooms.user(t.dealerId), 'dealer:seat', { status: 'assigned', tableId: t.tableId, tableName: table.name });
  }
  ctx.events.emit(rooms.staff(t.clubId), 'floor:changed', { tableId: t.tableId });
  return t;
}

export async function cancel(ctx: AppContext, access: ClubAccess, tournamentId: string) {
  const result = await ctx.db.transaction(async (tx) => {
    const t = await getTournament(tx, tournamentId, true);
    if (!BUSY.includes(t.status)) throw new AppError('trm.not_active', 409);
    return cancelTournament(ctx, tx, t, access.user.id);
  });
  const t = result.tournament;
  emitTournament(ctx, t, 'tournament:cancelled', { refundedCents: result.refundedCents });
  for (const userId of result.userIds) ctx.events.emit(rooms.user(userId), 'tournament:cancelled', { tournamentId: t.id });
  if (result.cancelledHandId) ctx.events.emit(rooms.table(t.tableId), 'hand:cancelled', { tableId: t.tableId, handId: result.cancelledHandId });
  ctx.events.emit(rooms.table(t.tableId), 'table:closed', { tableId: t.tableId });
  ctx.events.emit(rooms.staff(t.clubId), 'floor:changed', { tableId: t.tableId });
  return { tournament: t, refundedCents: result.refundedCents };
}

export async function finish(ctx: AppContext, access: ClubAccess, tournamentId: string) {
  const result = await ctx.db.transaction(async (tx) => {
    const t = await getTournament(tx, tournamentId, true);
    if (t.status !== 'active') throw new AppError('trm.not_active', 409);
    return finishTournament(ctx, tx, t, access.user.id);
  });
  emitFinished(ctx, result);
  return result;
}

export async function togglePin(ctx: AppContext, tournamentId: string) {
  const t = await getTournament(ctx.db, tournamentId);
  const [row] = await ctx.db.update(tournaments).set({ pinned: !t.pinned }).where(eq(tournaments.id, t.id)).returning();
  emitTournament(ctx, row!, 'tournament:updated', { pinned: row!.pinned });
  return { pinned: row!.pinned };
}

/** Turns auto-deal on (every `seconds`) — the table's human dealer, if any, is stood up. */
export async function startAutoDeal(ctx: AppContext, tournamentId: string, seconds: number) {
  const t = await ctx.db.transaction(async (tx) => {
    const t = await getTournament(tx, tournamentId, true);
    if (!BUSY.includes(t.status)) throw new AppError('trm.not_active', 409);
    const hand = await liveHand(tx, t.tableId);
    const table = await getTable(tx, t.clubId, t.tableId, true);
    if (hand && table.dealerId) throw new AppError('dealer.hand_live', 409, { hand: hand.handNumber });
    const [row] = await tx.update(tournaments).set({ autoDealSeconds: seconds, dealerId: null }).where(eq(tournaments.id, t.id)).returning();
    await tx.update(clubTables).set({
      autoDealSeconds: seconds, dealerId: null, ...(t.status === 'active' ? { isAutoDeal: true } : {}),
    }).where(eq(clubTables.id, t.tableId));
    await logEvent(tx, t.id, 'auto_deal_on', { seconds });
    return row!;
  });
  emitTournament(ctx, t, 'tournament:updated', { autoDealSeconds: seconds, autoDeal: true });
  ctx.events.emit(rooms.staff(t.clubId), 'floor:changed', { tableId: t.tableId });
  return { autoDeal: true, intervalSeconds: seconds };
}

/** Stops auto-deal; a hand in progress is flopped first so nothing is left hanging. */
export async function stopAutoDeal(ctx: AppContext, tournamentId: string) {
  const t = await getTournament(ctx.db, tournamentId);
  const table = await getTable(ctx.db, t.clubId, t.tableId);
  if (table.isAutoDeal && (await liveHand(ctx.db, table.id))) await autoFlop(ctx, t.clubId, table.id);
  await ctx.db.update(clubTables).set({ isAutoDeal: false }).where(eq(clubTables.id, t.tableId));
  await logEvent(ctx.db, t.id, 'auto_deal_off');
  emitTournament(ctx, t, 'tournament:updated', { autoDeal: false });
  ctx.events.emit(rooms.staff(t.clubId), 'floor:changed', { tableId: t.tableId });
  return { autoDeal: false };
}
