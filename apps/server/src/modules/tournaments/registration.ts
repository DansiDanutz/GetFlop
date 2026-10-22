/** Player actions: register, unregister, rebuy, add-on (docs/spec/10 §4–5). */
import { eq, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { Tx } from '../../db/client.js';
import { tournamentEntries } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { assertCan, type ClubAccess } from '../clubs/access.js';
import { levelOf } from '../commerce/levels.js';
import { chargeEntry, refundEntry } from './money.js';
import { UNREGISTER_CUTOFF_MINUTES } from './rules.js';
import { emitTournament, findEntry, getTournament, logEvent, type TournamentRow } from './store.js';

const MINUTE_MS = 60_000;

export function lateRegOpen(t: TournamentRow): boolean {
  return t.status === 'active' && t.allowLateRegistration && t.handsPlayed + 1 <= t.lateRegEndHand && t.handsPlayed < t.endValue;
}

export function registrationOpen(t: TournamentRow): boolean {
  return t.status === 'upcoming' || lateRegOpen(t);
}

/** Refund rule shown before registering: until the start, until 1 minute before an auto start, or final. */
export function refundRule(t: TournamentRow): 'until_start' | 'until_cutoff' | 'final' {
  if (t.status !== 'upcoming') return 'final';
  return t.autoStart && t.scheduledAt ? 'until_cutoff' : 'until_start';
}

function assertTournamentsAvailable(access: ClubAccess): void {
  if (levelOf(access.club.level).tournaments === 0) throw new AppError('commerce.tournament_unavailable', 409);
}

export async function register(ctx: AppContext, access: ClubAccess, tournamentId: string) {
  assertCan(access, 'play');
  assertTournamentsAvailable(access);
  const userId = access.user.id;
  const { t, entry } = await ctx.db.transaction(async (tx) => {
    const t = await getTournament(tx, tournamentId, true);
    if (!registrationOpen(t)) throw new AppError('trm.registration_closed', 409);
    const existing = await findEntry(tx, t.id, userId, true);
    if (existing && existing.status !== 'unregistered') throw new AppError('trm.already_registered', 409);
    const isBot = access.user.isBot;
    if (!isBot) {
      await chargeEntry(tx, { clubId: t.clubId, userId, tournamentId: t.id, poolCents: t.buyInCents, feeCents: t.feeCents, kind: 'tournament_buyin' });
    }
    const running = t.status === 'active';
    const values = {
      status: running ? 'active' as const : 'registered' as const, isBot,
      chips: running ? t.startingStack : 0, chipsInPlay: 0, rebuys: 0, addons: 0,
      paidCents: isBot ? 0 : t.buyInCents, feesCents: isBot ? 0 : t.feeCents,
      handsActed: 0, handsDealt: 0, registeredAtHand: t.handsPlayed, outAtHand: null, eliminatedReason: null,
      finishPosition: null, prizeCents: 0, registeredAt: ctx.now(),
    };
    const [row] = existing
      ? await tx.update(tournamentEntries).set(values).where(eq(tournamentEntries.id, existing.id)).returning()
      : await tx.insert(tournamentEntries).values({ ...values, tournamentId: t.id, clubId: t.clubId, userId }).returning();
    await logEvent(tx, t.id, 'registered', { username: access.user.username, late: running });
    return { t, entry: row! };
  });
  emitTournament(ctx, t, 'tournament:registered', { username: access.user.username });
  if (entry.status === 'active') ctx.events.emit(rooms.user(userId), 'tournament:chips:updated', { tournamentId: t.id, chips: entry.chips });
  ctx.events.emit(rooms.staff(t.clubId), 'floor:changed', { tableId: t.tableId });
  return { registered: true, status: entry.status, chips: entry.chips, paidCents: entry.paidCents + entry.feesCents, refundRule: refundRule(t) };
}

export async function unregister(ctx: AppContext, access: ClubAccess, tournamentId: string) {
  const userId = access.user.id;
  const { t, refunded } = await ctx.db.transaction(async (tx) => {
    const t = await getTournament(tx, tournamentId, true);
    const entry = await findEntry(tx, t.id, userId, true);
    if (!entry || entry.status === 'unregistered') throw new AppError('trm.not_registered', 409);
    if (t.status !== 'upcoming') throw new AppError('trm.unregister_started', 409);
    if (t.autoStart && t.scheduledAt && ctx.now().getTime() > t.scheduledAt.getTime() - UNREGISTER_CUTOFF_MINUTES * MINUTE_MS) {
      throw new AppError('trm.unregister_cutoff', 409, { minutes: UNREGISTER_CUTOFF_MINUTES });
    }
    const refunded = await refundEntry(tx, t.clubId, t.id, entry, userId);
    await tx.update(tournamentEntries).set({ status: 'unregistered', paidCents: 0, feesCents: 0 }).where(eq(tournamentEntries.id, entry.id));
    await logEvent(tx, t.id, 'unregistered', { username: access.user.username, refundedCents: refunded });
    return { t, refunded };
  });
  emitTournament(ctx, t, 'tournament:unregistered', { username: access.user.username });
  return { unregistered: true, refundedCents: refunded };
}

async function lockActiveEntry(tx: Tx, tournamentId: string, userId: string) {
  const t = await getTournament(tx, tournamentId, true);
  const entry = await findEntry(tx, t.id, userId, true);
  if (!entry || entry.status === 'unregistered') throw new AppError('trm.not_registered', 409);
  if (t.status !== 'active') throw new AppError('trm.not_active', 409);
  return { t, entry };
}

export async function rebuy(ctx: AppContext, access: ClubAccess, tournamentId: string) {
  assertCan(access, 'play');
  const userId = access.user.id;
  const { t, chips, rebuys } = await ctx.db.transaction(async (tx) => {
    const { t, entry } = await lockActiveEntry(tx, tournamentId, userId);
    if (!t.allowRebuys) throw new AppError('trm.rebuys_not_allowed', 409);
    if (t.handsPlayed + 1 > t.rebuyEndHand) throw new AppError('trm.rebuy_period_ended', 409);
    if (t.maxRebuys !== -1 && entry.rebuys >= t.maxRebuys) throw new AppError('trm.max_rebuys', 409, { max: t.maxRebuys });
    if (entry.chips + entry.chipsInPlay > 0) throw new AppError('trm.rebuy_needs_zero', 409);
    if (entry.status !== 'active') throw new AppError('coupon.not_active', 409);
    if (!entry.isBot) {
      await chargeEntry(tx, { clubId: t.clubId, userId, tournamentId: t.id, poolCents: t.rebuyCostCents, feeCents: t.rebuyFeeCents, kind: 'tournament_rebuy' });
    }
    const paid = entry.isBot ? 0 : t.rebuyCostCents;
    const fee = entry.isBot ? 0 : t.rebuyFeeCents;
    const [row] = await tx.update(tournamentEntries).set({
      chips: sql`${tournamentEntries.chips} + ${t.rebuyStack}`, rebuys: sql`${tournamentEntries.rebuys} + 1`,
      paidCents: sql`${tournamentEntries.paidCents} + ${paid}`, feesCents: sql`${tournamentEntries.feesCents} + ${fee}`,
    }).where(eq(tournamentEntries.id, entry.id)).returning();
    await logEvent(tx, t.id, 'rebuy', { username: access.user.username, rebuys: row!.rebuys });
    return { t, chips: row!.chips, rebuys: row!.rebuys };
  });
  emitTournament(ctx, t, 'tournament:rebuy', { username: access.user.username });
  ctx.events.emit(rooms.user(userId), 'tournament:chips:updated', { tournamentId: t.id, chips });
  return { chips, rebuys };
}

export async function addon(ctx: AppContext, access: ClubAccess, tournamentId: string) {
  assertCan(access, 'play');
  const userId = access.user.id;
  const { t, chips } = await ctx.db.transaction(async (tx) => {
    const { t, entry } = await lockActiveEntry(tx, tournamentId, userId);
    if (!t.allowAddons) throw new AppError('trm.addons_not_allowed', 409);
    if (entry.addons > 0) throw new AppError('trm.addon_already_taken', 409);
    const next = t.handsPlayed + 1;
    if (next <= t.rebuyEndHand) throw new AppError('trm.addon_not_started', 409);
    if (next > t.addonEndHand) throw new AppError('trm.addon_ended', 409);
    if (entry.status !== 'active') throw new AppError('trm.addon_needs_active', 409);
    if (entry.chips + entry.chipsInPlay <= 0) throw new AppError('trm.addon_no_chips', 409);
    if (!entry.isBot) {
      await chargeEntry(tx, { clubId: t.clubId, userId, tournamentId: t.id, poolCents: t.addonCostCents, feeCents: 0, kind: 'tournament_addon' });
    }
    const [row] = await tx.update(tournamentEntries).set({
      chips: sql`${tournamentEntries.chips} + ${t.addonStack}`, addons: 1,
      paidCents: sql`${tournamentEntries.paidCents} + ${entry.isBot ? 0 : t.addonCostCents}`,
    }).where(eq(tournamentEntries.id, entry.id)).returning();
    await logEvent(tx, t.id, 'addon', { username: access.user.username });
    return { t, chips: row!.chips };
  });
  emitTournament(ctx, t, 'tournament:addon', { username: access.user.username });
  ctx.events.emit(rooms.user(userId), 'tournament:chips:updated', { tournamentId: t.id, chips });
  return { chips };
}
