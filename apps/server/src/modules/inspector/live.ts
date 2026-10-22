import { and, desc, eq, gte, inArray, or, type SQL } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { clubTables, couponLegs, coupons, ledgerEntries, memberships, users } from '../../db/schema/index.js';
import { assertCan, type ClubAccess } from '../clubs/access.js';
import { totals } from './metrics.js';
import { bigThresholdCents, displayName, settledBets, userNames } from './queries.js';
import { currentOpenSession } from './sessions.js';
import { clubDayStart, clubTz, OPEN_END } from './time.js';

const LIVE_ROWS_LIMIT = 200;

export interface LiveWindow { readonly kind: 'session' | 'today'; readonly number: number | null; readonly since: Date }

/** The current session, or today since 06:00 local when no session is open. */
export async function liveWindow(ctx: AppContext, access: ClubAccess, tz?: string): Promise<LiveWindow> {
  const open = await currentOpenSession(ctx, access);
  if (open) return { kind: 'session', number: open.number, since: open.openedAt };
  return { kind: 'today', number: null, since: clubDayStart(ctx.now(), clubTz(access.club.settings, tz)) };
}

export type CouponOutcome = 'in_progress' | 'won' | 'lost' | 'voided';

export function couponOutcome(c: { status: string; wonCents: number }): CouponOutcome {
  if (c.status === 'live') return 'in_progress';
  if (c.status === 'voided') return 'voided';
  return c.wonCents > 0 ? 'won' : 'lost';
}

export interface LiveBetsQuery { readonly tz?: string; readonly tableId?: string; readonly wins?: boolean; readonly big?: boolean }

export async function liveBets(ctx: AppContext, access: ClubAccess, q: LiveBetsQuery) {
  assertCan(access, 'reports');
  const clubId = access.club.id;
  const window = await liveWindow(ctx, access, q.tz);
  const range = { from: window.since, to: OPEN_END };
  const settled = await settledBets(ctx.db, clubId, { range, unit: 'points', tableIds: q.tableId ? [q.tableId] : undefined });
  const t = totals(settled);
  const conditions: SQL[] = [eq(coupons.clubId, clubId), eq(coupons.unit, 'points'),
    or(gte(coupons.createdAt, window.since), eq(coupons.status, 'live'))!];
  if (q.tableId) conditions.push(eq(coupons.tableId, q.tableId));
  const list = await ctx.db.select({ coupon: coupons, tableName: clubTables.name, username: users.username, displayName: users.displayName })
    .from(coupons).innerJoin(clubTables, eq(clubTables.id, coupons.tableId)).innerJoin(users, eq(users.id, coupons.userId))
    .where(and(...conditions)).orderBy(desc(coupons.createdAt)).limit(LIVE_ROWS_LIMIT);
  const legs = list.length === 0 ? [] : await ctx.db.select().from(couponLegs)
    .where(inArray(couponLegs.couponId, list.map((r) => r.coupon.id)));
  const big = bigThresholdCents(access.club);
  const rows = list.map(({ coupon: c, tableName, ...u }) => {
    const outcome = couponOutcome(c);
    return {
      couponId: c.id, userId: c.userId, player: displayName(u), tableId: c.tableId, tableName,
      picks: legs.filter((l) => l.couponId === c.id)
        .map((l) => ({ market: l.market, stakeCents: l.stakeCents, multiplier: l.multiplierX100 / 100, status: l.status })),
      rounds: c.rounds, roundsSettled: c.roundsSettled, outcome, committedCents: c.committedCents, wonCents: c.wonCents,
      refundedCents: c.refundedCents, lostCents: Math.max(0, c.committedCents - c.refundedCents - c.wonCents),
      createdAt: c.createdAt, isBig: c.committedCents >= big || c.wonCents >= big,
    };
  }).filter((r) => (!q.wins || r.wonCents > 0) && (!q.big || r.isBig));
  return {
    window,
    totals: { stakedCents: t.handleCents, paidCents: t.paidCents, clubCents: t.resultCents },
    bigThresholdCents: big,
    rows,
  };
}

const MOVEMENT_TYPES: Record<string, 'send_out' | 'claim_back' | 'request' | 'return'> = {
  deposit: 'send_out', withdrawal: 'claim_back', reload: 'request', cashout: 'return',
};
const GIVEN = new Set(['deposit', 'reload']);

export async function livePoints(ctx: AppContext, access: ClubAccess, q: { tz?: string; actor?: string }) {
  assertCan(access, 'reports');
  const clubId = access.club.id;
  const window = await liveWindow(ctx, access, q.tz);
  const actorId = q.actor === 'me' ? access.user.id : q.actor || undefined;
  const conditions: SQL[] = [eq(ledgerEntries.clubId, clubId), inArray(ledgerEntries.kind, Object.keys(MOVEMENT_TYPES)),
    gte(ledgerEntries.createdAt, window.since)];
  if (actorId) conditions.push(eq(ledgerEntries.actorId, actorId));
  const entries = await ctx.db.select().from(ledgerEntries).where(and(...conditions))
    .orderBy(desc(ledgerEntries.createdAt)).limit(LIVE_ROWS_LIMIT);
  const names = await userNames(ctx.db, entries.flatMap((e) => [e.userId, e.actorId]));
  const given = entries.filter((e) => GIVEN.has(e.kind)).reduce((s, e) => s + e.amountCents, 0);
  const taken = entries.filter((e) => !GIVEN.has(e.kind)).reduce((s, e) => s + e.amountCents, 0);
  const staff = await ctx.db.select({ id: users.id, username: users.username, displayName: users.displayName, roles: memberships.roles })
    .from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.clubId, clubId), eq(memberships.status, 'active')));
  return {
    window,
    totals: { givenCents: given, takenCents: taken, netCents: given - taken },
    staff: staff.filter((s) => s.roles.some((r) => r !== 'dealer')).map((s) => ({ id: s.id, name: displayName(s) })),
    rows: entries.map((e) => ({
      id: e.id, type: MOVEMENT_TYPES[e.kind]!, amountCents: e.amountCents, userId: e.userId,
      player: e.userId ? names.get(e.userId) ?? '' : '', actorId: e.actorId,
      actor: e.actorId ? names.get(e.actorId) ?? '' : null, byMe: e.actorId === access.user.id,
      byPlayer: e.actorId !== null && e.actorId === e.userId, createdAt: e.createdAt,
    })),
  };
}
