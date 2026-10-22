import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { bets, coupons, hands, memberPrefs, memberships, pointRequests, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { can, type ClubAccess } from '../clubs/access.js';
import { balanceOf, wallet } from '../points/ledger.js';
import { periodWindow, type BoardPeriod, type Window } from './periods.js';
import { boardEnabled } from './settings.js';
import { nameOf } from './shared.js';

export type BoardMetric = 'net' | 'flops';
const TOP_SHOWN = 10;
const PODIUM = 3;

export function assertMember(access: ClubAccess): void {
  if (!access.membership && !access.isAdmin) throw new AppError('club.access_denied', 403);
}

interface Standing { userId: string; name: string; hidden: boolean; value: number }

const settledPointBets = (clubId: string, w: Window) => and(
  eq(bets.clubId, clubId), eq(coupons.unit, 'points'), inArray(bets.status, ['won', 'lost']),
  eq(hands.status, 'settled'), gte(hands.settledAt, w.start), lt(hands.settledAt, w.end),
);

async function hiddenSet(ctx: AppContext, clubId: string): Promise<Set<string>> {
  const rows = await ctx.db.select({ userId: memberPrefs.userId }).from(memberPrefs)
    .where(and(eq(memberPrefs.clubId, clubId), eq(memberPrefs.boardHidden, true)));
  return new Set(rows.map((r) => r.userId));
}

/** Everyone who played a settled Ring Game flop in the window, ranked by the metric. */
async function standings(ctx: AppContext, clubId: string, w: Window, metric: BoardMetric, hidden: ReadonlySet<string>): Promise<Standing[]> {
  const value = metric === 'net'
    ? sql<string>`sum(${bets.payoutCents}) - sum(${bets.stakeCents})`
    : sql<string>`count(distinct ${bets.handId})`;
  const rows = await ctx.db.select({ userId: bets.userId, username: users.username, displayName: users.displayName, value })
    .from(bets).innerJoin(coupons, eq(coupons.id, bets.couponId)).innerJoin(hands, eq(hands.id, bets.handId))
    .innerJoin(users, eq(users.id, bets.userId))
    .innerJoin(memberships, and(eq(memberships.clubId, clubId), eq(memberships.userId, bets.userId), eq(memberships.status, 'active')))
    .where(settledPointBets(clubId, w)).groupBy(bets.userId, users.username, users.displayName);
  return rows
    .map((r) => ({ userId: r.userId, name: nameOf(r), hidden: hidden.has(r.userId), value: Number(r.value) }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

async function bestMoment(ctx: AppContext, clubId: string, w: Window, viewerId: string, hidden: ReadonlySet<string>) {
  const [row] = await ctx.db.select({ userId: bets.userId, username: users.username, displayName: users.displayName, market: bets.market, m: bets.multiplierX100 })
    .from(bets).innerJoin(coupons, eq(coupons.id, bets.couponId)).innerJoin(hands, eq(hands.id, bets.handId))
    .innerJoin(users, eq(users.id, bets.userId))
    .where(and(settledPointBets(clubId, w), eq(bets.status, 'won')))
    .orderBy(desc(bets.multiplierX100), desc(bets.payoutCents)).limit(1);
  if (!row) return null;
  const showName = !hidden.has(row.userId) || row.userId === viewerId;
  return { name: showName ? nameOf(row) : null, payoutOdds: (row.m - 100) / 100, betTypeSlug: row.market };
}

export interface BoardQuery { readonly period: BoardPeriod; readonly metric: BoardMetric; readonly tz?: string }

/** Club board (03 §11): members only; managers see a preview while it is turned off. */
export async function clubBoard(ctx: AppContext, access: ClubAccess, q: BoardQuery) {
  assertMember(access);
  const clubId = access.club.id;
  const enabled = boardEnabled(access.club);
  const preview = !enabled && can(access, 'settings');
  const w = periodWindow(q.period, ctx.now(), q.tz);
  const base = { enabled, preview, period: q.period, metric: q.metric, closesAt: w.end };
  if (!enabled && !preview) return { ...base, podium: [], top: [], me: null, bestMoment: null };
  const hidden = await hiddenSet(ctx, clubId);
  const list = await standings(ctx, clubId, w, q.metric, hidden);
  const viewer = access.user.id;
  const rows = list.map((s, i) => ({
    rank: i + 1, name: s.hidden && s.userId !== viewer ? null : s.name, value: s.value, me: s.userId === viewer,
  }));
  const mine = list.findIndex((s) => s.userId === viewer);
  return {
    ...base, podium: rows.slice(0, PODIUM), top: rows.slice(0, TOP_SHOWN),
    me: mine >= 0 ? { rank: mine + 1, value: list[mine]!.value, hidden: list[mine]!.hidden } : { rank: null, value: 0, hidden: hidden.has(viewer) },
    bestMoment: await bestMoment(ctx, clubId, w, viewer, hidden),
  };
}

export async function setBoardHidden(ctx: AppContext, access: ClubAccess, hidden: boolean) {
  assertMember(access);
  await ctx.db.insert(memberPrefs).values({ clubId: access.club.id, userId: access.user.id, boardHidden: hidden, updatedAt: ctx.now() })
    .onConflictDoUpdate({ target: [memberPrefs.clubId, memberPrefs.userId], set: { boardHidden: hidden, updatedAt: ctx.now() } });
  return { hidden };
}

/** Place and balance bar on the table view. */
export async function clubBar(ctx: AppContext, access: ClubAccess, tz?: string) {
  assertMember(access);
  const clubId = access.club.id;
  const userId = access.user.id;
  const w = periodWindow('week', ctx.now(), tz);
  const list = boardEnabled(access.club) ? await standings(ctx, clubId, w, 'net', new Set()) : [];
  const rank = list.findIndex((s) => s.userId === userId);
  const [pending] = await ctx.db.select({ id: pointRequests.id, kind: pointRequests.kind, amountCents: pointRequests.amountCents, createdAt: pointRequests.createdAt })
    .from(pointRequests)
    .where(and(eq(pointRequests.clubId, clubId), eq(pointRequests.userId, userId), eq(pointRequests.status, 'pending')))
    .orderBy(desc(pointRequests.createdAt)).limit(1);
  return {
    board: { rank: rank >= 0 ? rank + 1 : null }, balanceCents: await balanceOf(ctx.db, clubId, wallet(userId)),
    closesAt: w.end, pendingRequest: pending ?? null,
  };
}
