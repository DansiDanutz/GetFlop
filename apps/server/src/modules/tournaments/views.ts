/** Read models: lobby list, detail, control-panel list, monitor and logs (docs/spec/10 §3–8). */
import { and, count, desc, eq, inArray, ne } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { clubTables, pointAccounts, tournamentEntries, tournamentEvents, tournaments } from '../../db/schema/index.js';
import { publicHand } from '../game/hands.js';
import { liveHand } from '../game/tables.js';
import { standingsOf } from './lifecycle.js';
import { lateRegOpen, refundRule } from './registration.js';
import { rebuyAvailable } from './progress.js';
import { levelForHand, participation, placeShares, prizePoolCents, UNREGISTER_CUTOFF_MINUTES } from './rules.js';
import { entriesOf, findEntry, type EntryRow, type TournamentRow } from './store.js';

const LIST_LIMIT = 100;
const LOG_LIMIT = 200;
const MINUTE_MS = 60_000;
const STATUS_ORDER: Record<string, number> = { active: 0, upcoming: 1, finished: 2, cancelled: 3 };

interface Totals { entrants: number; inPlay: number; collected: number }

async function totalsFor(db: DbOrTx, ids: string[]): Promise<Map<string, Totals>> {
  const out = new Map<string, Totals>(ids.map((id) => [id, { entrants: 0, inPlay: 0, collected: 0 }]));
  if (ids.length === 0) return out;
  const rows = await db.select({ id: tournamentEntries.tournamentId, status: tournamentEntries.status, n: count() })
    .from(tournamentEntries).where(and(inArray(tournamentEntries.tournamentId, ids), ne(tournamentEntries.status, 'unregistered')))
    .groupBy(tournamentEntries.tournamentId, tournamentEntries.status);
  for (const r of rows) {
    const t = out.get(r.id)!;
    out.set(r.id, { ...t, entrants: t.entrants + r.n, inPlay: t.inPlay + (r.status === 'active' || r.status === 'registered' ? r.n : 0) });
  }
  const pools = await db.select({ refId: pointAccounts.refId, balance: pointAccounts.balanceCents }).from(pointAccounts)
    .where(and(eq(pointAccounts.kind, 'tournament'), inArray(pointAccounts.refId, ids)));
  for (const p of pools) if (p.refId && out.has(p.refId)) out.set(p.refId, { ...out.get(p.refId)!, collected: p.balance });
  return out;
}

export function poolNow(t: TournamentRow, collected: number): number {
  return t.finalPoolCents ?? prizePoolCents(t.prizePoolType, t.guaranteedPrizeCents, collected);
}

export function summary(t: TournamentRow, totals: Totals) {
  const level = levelForHand(t.levels, t.handsPlayed + 1);
  return {
    id: t.id, clubId: t.clubId, tableId: t.tableId, name: t.name, status: t.status, pinned: t.pinned,
    scheduledAt: t.scheduledAt, autoStart: t.autoStart, startedAt: t.startedAt, finishedAt: t.finishedAt,
    buyInCents: t.buyInCents, feeCents: t.feeCents, startingStack: t.startingStack,
    prizePoolType: t.prizePoolType, guaranteedPrizeCents: t.guaranteedPrizeCents,
    poolCents: poolNow(t, totals.collected), collectedCents: totals.collected,
    entrants: totals.entrants, inPlay: totals.inPlay,
    handsPlayed: t.handsPlayed, endCondition: t.endCondition, endValue: t.endValue,
    currentLevel: level.levelNumber, levelMinChips: level.minBetChips, levelMaxChips: level.maxBetChips,
    lateRegOpen: lateRegOpen(t), allowLateRegistration: t.allowLateRegistration, lateRegEndHand: t.lateRegEndHand,
    allowRebuys: t.allowRebuys, rebuyEndHand: t.rebuyEndHand, allowAddons: t.allowAddons, addonEndHand: t.addonEndHand,
    dealing: t.autoDealSeconds !== null ? 'auto' as const : 'dealer' as const, autoDealSeconds: t.autoDealSeconds,
    dealerId: t.dealerId, botsAllowed: t.botsAllowed, minActionPct: t.minActionPct, markets: t.markets,
  };
}

function sortLobby<T extends { pinned: boolean; status: string; scheduledAt: Date | null; createdAt: Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => Number(b.pinned) - Number(a.pinned)
    || (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    || (a.scheduledAt?.getTime() ?? Infinity) - (b.scheduledAt?.getTime() ?? Infinity)
    || b.createdAt.getTime() - a.createdAt.getTime());
}

/** Lobby (players) and control panel (staff): pinned first, running, upcoming, finished. */
export async function listTournaments(ctx: AppContext, clubId: string, userId: string, opts: { includeCancelled?: boolean } = {}) {
  const where = opts.includeCancelled ? eq(tournaments.clubId, clubId) : and(eq(tournaments.clubId, clubId), ne(tournaments.status, 'cancelled'));
  const rows = sortLobby(await ctx.db.select().from(tournaments).where(where).orderBy(desc(tournaments.createdAt)).limit(LIST_LIMIT));
  const totals = await totalsFor(ctx.db, rows.map((t) => t.id));
  const mine = rows.length === 0 ? [] : await ctx.db.select().from(tournamentEntries)
    .where(and(eq(tournamentEntries.userId, userId), inArray(tournamentEntries.tournamentId, rows.map((t) => t.id))));
  const tables = rows.length === 0 ? [] : await ctx.db.select({ id: clubTables.id, name: clubTables.name }).from(clubTables)
    .where(inArray(clubTables.id, rows.map((t) => t.tableId)));
  return rows.map((t) => {
    const me = mine.find((e) => e.tournamentId === t.id && e.status !== 'unregistered');
    return {
      ...summary(t, totals.get(t.id)!), tableName: tables.find((x) => x.id === t.tableId)?.name ?? '',
      registered: Boolean(me), myStatus: me?.status ?? null, myChips: me ? me.chips + me.chipsInPlay : null,
    };
  });
}

function participationOf(t: TournamentRow, e: EntryRow) {
  return participation({ minActionPct: t.minActionPct, totalHands: t.endValue, handsPlayed: t.handsPlayed, done: e.handsActed, dealt: e.handsDealt });
}

function canUnregister(ctx: AppContext, t: TournamentRow): boolean {
  if (t.status !== 'upcoming') return false;
  if (!t.autoStart || !t.scheduledAt) return true;
  return ctx.now().getTime() <= t.scheduledAt.getTime() - UNREGISTER_CUTOFF_MINUTES * MINUTE_MS;
}

function registrationView(ctx: AppContext, t: TournamentRow, e: EntryRow | null, rank: number | null) {
  if (!e || e.status === 'unregistered') return { registered: false, refundRule: refundRule(t) };
  const next = t.handsPlayed + 1;
  const stack = e.chips + e.chipsInPlay;
  return {
    registered: true, status: e.status, chips: e.chips, chipsInPlay: e.chipsInPlay, rank, rebuys: e.rebuys, addons: e.addons,
    paidCents: e.paidCents + e.feesCents, refundRule: refundRule(t), canUnregister: canUnregister(ctx, t),
    canRebuy: t.status === 'active' && e.status === 'active' && stack === 0 && rebuyAvailable(t, e),
    canAddon: t.status === 'active' && e.status === 'active' && t.allowAddons && e.addons === 0 && stack > 0
      && next > t.rebuyEndHand && next <= t.addonEndHand,
    finishPosition: e.finishPosition, prizeCents: e.prizeCents, eliminatedReason: e.eliminatedReason, outAtHand: e.outAtHand,
  };
}

export async function tournamentDetail(ctx: AppContext, t: TournamentRow, userId: string) {
  const totals = (await totalsFor(ctx.db, [t.id])).get(t.id)!;
  const entries = await entriesOf(ctx.db, t.id);
  const pool = poolNow(t, totals.collected);
  const standings = await standingsOf(ctx.db, t, entries, pool);
  const me = await findEntry(ctx.db, t.id, userId);
  const rank = standings.find((s) => s.userId === userId)?.position ?? null;
  return {
    tournament: { ...summary(t, totals), rebuyStack: t.rebuyStack, rebuyCostCents: t.rebuyCostCents, rebuyFeeCents: t.rebuyFeeCents,
      maxRebuys: t.maxRebuys, addonCostCents: t.addonCostCents, addonStack: t.addonStack, payoutStructure: t.payoutStructure },
    levels: t.levels,
    payouts: placeShares(pool, t.payoutStructure).map((prizeCents, i) => ({ place: i + 1, pct: t.payoutStructure[i]!, prizeCents })),
    registration: registrationView(ctx, t, me, rank),
    myParticipation: me && me.status !== 'unregistered' && t.status !== 'upcoming' ? participationOf(t, me) : null,
    standings,
  };
}

export async function monitor(ctx: AppContext, t: TournamentRow) {
  const totals = (await totalsFor(ctx.db, [t.id])).get(t.id)!;
  const entries = await entriesOf(ctx.db, t.id);
  const pool = poolNow(t, totals.collected);
  const standings = await standingsOf(ctx.db, t, entries, pool);
  const byUser = new Map(entries.map((e) => [e.userId, e]));
  const inPlay = standings.filter((s) => s.status === 'active' || s.status === 'registered');
  const stacks = inPlay.map((s) => s.chips + (byUser.get(s.userId)?.chipsInPlay ?? 0));
  const [table] = await ctx.db.select().from(clubTables).where(eq(clubTables.id, t.tableId));
  const hand = await liveHand(ctx.db, t.tableId);
  const level = levelForHand(t.levels, t.handsPlayed + 1);
  const leader = inPlay[0];
  return {
    tournament: summary(t, totals),
    level, hand: t.handsPlayed, liveHand: hand ? publicHand(hand) : null,
    lateRegOpen: lateRegOpen(t),
    autoDeal: { on: Boolean(table?.isAutoDeal), intervalSeconds: table?.autoDealSeconds ?? t.autoDealSeconds },
    kpis: {
      entrants: entries.length, inPlay: inPlay.length, eliminated: entries.length - inPlay.length,
      avgStack: stacks.length > 0 ? Math.floor(stacks.reduce((s, v) => s + v, 0) / stacks.length) : 0,
      chipLeader: leader ? { username: leader.username, chips: stacks[0] ?? 0 } : null,
      poolCents: pool, collectedCents: totals.collected,
      reservedCents: t.prizePoolType === 'guaranteed' && (t.status === 'upcoming' || t.status === 'active')
        ? Math.max(0, t.guaranteedPrizeCents - totals.collected) : 0,
    },
    standings: standings.map((s) => {
      const e = byUser.get(s.userId)!;
      return { ...s, chipsInPlay: e.chipsInPlay, participation: t.status === 'upcoming' ? null : participationOf(t, e) };
    }),
  };
}

export async function logs(ctx: AppContext, tournamentId: string) {
  const rows = await ctx.db.select().from(tournamentEvents).where(eq(tournamentEvents.tournamentId, tournamentId))
    .orderBy(desc(tournamentEvents.createdAt), desc(tournamentEvents.id)).limit(LOG_LIMIT);
  return { events: rows.map((r) => ({ id: r.id, severity: r.severity, kind: r.kind, data: r.data, createdAt: r.createdAt })) };
}
