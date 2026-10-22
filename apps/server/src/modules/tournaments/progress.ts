/**
 * After every settled tournament hand (inside the settlement transaction): hand count,
 * participation counters, level progression, busts, participation eliminations and the
 * end condition. Events are emitted after the commit (afterSettled).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { Tx } from '../../db/client.js';
import { tournamentEntries, tournaments } from '../../db/schema/index.js';
import { rooms } from '../../realtime/events.js';
import type { AfterHook, SettledHook } from '../game/hooks.js';
import { finishTournament, voidTournamentCoupons, type FinishResult, type VoidedCoupon } from './lifecycle.js';
import { lateRegOpen } from './registration.js';
import { cannotMeetParticipation, levelForHand } from './rules.js';
import { emitTournament, entriesOf, logEvent, namesOf, tournamentRoom, type EntryRow, type TournamentRow } from './store.js';

interface HandOutcome {
  readonly tournament: TournamentRow;
  readonly levelChanged: boolean;
  readonly out: readonly { userId: string; reason: 'chips' | 'participation' }[];
  readonly chips: readonly { userId: string; chips: number }[];
  readonly voided: readonly VoidedCoupon[];
  readonly finished: FinishResult | null;
}

/** Outcomes waiting for the commit, by hand id. */
const pending = new Map<string, HandOutcome>();

export function rebuyAvailable(t: TournamentRow, e: EntryRow): boolean {
  return t.allowRebuys && t.handsPlayed + 1 <= t.rebuyEndHand && (t.maxRebuys === -1 || e.rebuys < t.maxRebuys);
}

async function countHand(tx: Tx, t: TournamentRow, actors: readonly string[]): Promise<void> {
  const inPlay = and(eq(tournamentEntries.tournamentId, t.id), eq(tournamentEntries.status, 'active'));
  await tx.update(tournamentEntries).set({ handsDealt: sql`${tournamentEntries.handsDealt} + 1` }).where(inPlay);
  if (actors.length > 0) {
    await tx.update(tournamentEntries).set({ handsActed: sql`${tournamentEntries.handsActed} + 1` })
      .where(and(inPlay, inArray(tournamentEntries.userId, [...actors])));
  }
}

/** Busts players with no chips and no rebuy left; eliminates those who can no longer meet participation. */
async function knockOut(ctx: AppContext, tx: Tx, t: TournamentRow) {
  const out: { userId: string; reason: 'chips' | 'participation' }[] = [];
  const voided: VoidedCoupon[] = [];
  for (const e of (await entriesOf(tx, t.id)).filter((x) => x.status === 'active')) {
    const busted = e.chips + e.chipsInPlay === 0 && !rebuyAvailable(t, e);
    const lazy = !busted && cannotMeetParticipation({ minActionPct: t.minActionPct, totalHands: t.endValue, handsPlayed: t.handsPlayed, done: e.handsActed });
    if (!busted && !lazy) continue;
    if (lazy) voided.push(...await voidTournamentCoupons(ctx, tx, t, e.userId));
    const reason = busted ? 'chips' as const : 'participation' as const;
    await tx.update(tournamentEntries).set({
      status: busted ? 'busted' : 'eliminated', eliminatedReason: reason, outAtHand: t.handsPlayed,
    }).where(eq(tournamentEntries.id, e.id));
    out.push({ userId: e.userId, reason });
  }
  return { out, voided };
}

export const onTournamentHandSettled: SettledHook = async (ctx, tx, info) => {
  if (info.table.kind !== 'tournament' || !info.table.tournamentId) return;
  const [before] = await tx.select().from(tournaments).where(eq(tournaments.id, info.table.tournamentId)).for('update');
  if (!before || before.status !== 'active') return;
  const actors = [...new Set(info.bets.map((b) => b.userId))];
  await countHand(tx, before, actors);
  const handsPlayed = before.handsPlayed + 1;
  const currentLevel = levelForHand(before.levels, handsPlayed + 1).levelNumber;
  const [t] = await tx.update(tournaments).set({ handsPlayed, currentLevel }).where(eq(tournaments.id, before.id)).returning();
  const { out, voided } = await knockOut(ctx, tx, t!);
  const entries = await entriesOf(tx, t!.id);
  const stillIn = entries.filter((e) => e.status === 'active').length;
  const handsDone = t!.endCondition === 'hands' && handsPlayed >= t!.endValue;
  const nobodyLeft = stillIn === 0 && !lateRegOpen(t!);
  if (handsDone || nobodyLeft) await logEvent(tx, t!.id, 'auto_end', { handsPlayed, reason: handsDone ? 'hands' : 'no_players' });
  const finished = handsDone || nobodyLeft ? await finishTournament(ctx, tx, t!, null) : null;
  const chips = entries.filter((e) => actors.includes(e.userId)).map((e) => ({ userId: e.userId, chips: e.chips }));
  pending.set(info.hand.id, {
    tournament: finished?.tournament ?? t!, levelChanged: currentLevel !== before.currentLevel, out, chips, voided, finished,
  });
};

export function emitFinished(ctx: AppContext, result: FinishResult): void {
  const t = result.tournament;
  emitTournament(ctx, t, 'tournament:finished', { poolCents: result.poolCents, standings: result.standings });
  for (const v of result.voided) {
    ctx.events.emit(rooms.user(v.userId), 'coupon:voided', { ...v, tableId: t.tableId, unit: 'chips' });
  }
  if (result.cancelledHandId) ctx.events.emit(rooms.table(t.tableId), 'hand:cancelled', { tableId: t.tableId, handId: result.cancelledHandId });
  ctx.events.emit(rooms.table(t.tableId), 'table:closed', { tableId: t.tableId });
  ctx.events.emit(rooms.staff(t.clubId), 'floor:changed', { tableId: t.tableId });
}

export const afterTournamentHand: AfterHook = async (ctx, info) => {
  const outcome = pending.get(info.hand.id);
  if (!outcome) return;
  pending.delete(info.hand.id);
  const t = outcome.tournament;
  const names = await namesOf(ctx.db, [...outcome.out.map((o) => o.userId), ...outcome.chips.map((c) => c.userId)]);
  for (const c of outcome.chips) {
    ctx.events.emit(rooms.user(c.userId), 'tournament:chips:updated', { tournamentId: t.id, chips: c.chips });
    ctx.events.emit(tournamentRoom(t.id), 'tournament:chips:updated', { tournamentId: t.id, chips: c.chips, username: names.get(c.userId)?.name });
  }
  for (const o of outcome.out) {
    emitTournament(ctx, t, 'tournament:player:busted', { username: names.get(o.userId)?.name ?? '', userId: o.userId, reason: o.reason });
  }
  for (const v of outcome.voided) ctx.events.emit(rooms.user(v.userId), 'coupon:voided', { ...v, tableId: t.tableId, unit: 'chips' });
  if (outcome.levelChanged && !outcome.finished) {
    const level = levelForHand(t.levels, t.handsPlayed + 1);
    emitTournament(ctx, t, 'tournament:level:updated', { levelNumber: level.levelNumber, minBetChips: level.minBetChips, maxBetChips: level.maxBetChips });
  }
  if (outcome.finished) emitFinished(ctx, outcome.finished);
};
