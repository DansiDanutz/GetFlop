import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { bets, coupons, hands, ledgerEntries, pointAccounts, users } from '../../db/schema/index.js';
import { clubDayStart, clubTz, DAY_START_HOUR, lastDays, type Range } from '../inspector/time.js';
import { supply, walletDrift } from '../points/ledger.js';
import { activeClubs } from './figures.js';

/** Ledger kinds that put Points in a player's hands (Send Out, approved load) or take them back. */
export const SENT_KINDS = ['deposit', 'reload'] as const;
export const CLAIMED_KINDS = ['withdrawal', 'cashout'] as const;
export const RECONCILIATION_DAYS = 30;

/** The club day (YYYY-MM-DD) a timestamp falls in: local time shifted back by the 06:00 cut-off. */
const clubDay = (column: typeof hands.settledAt | typeof ledgerEntries.createdAt, tz: string) =>
  sql<string>`to_char((${column} at time zone ${tz}) - make_interval(hours => ${DAY_START_HOUR}), 'YYYY-MM-DD')`;

interface DayRow {
  readonly date: string;
  readonly picks: number;
  readonly playedCents: number;
  readonly wonCents: number;
  readonly sentCents: number;
  readonly claimedCents: number;
}

async function playDays(ctx: AppContext, clubId: string, tz: string, range: Range) {
  const day = clubDay(hands.settledAt, tz);
  const rows = await ctx.db.select({
    date: day, picks: sql<number>`cast(count(*) as int)`,
    played: sql<string>`coalesce(sum(${bets.stakeCents}), 0)`, won: sql<string>`coalesce(sum(${bets.payoutCents}), 0)`,
  }).from(bets)
    .innerJoin(hands, eq(hands.id, bets.handId)).innerJoin(coupons, eq(coupons.id, bets.couponId)).innerJoin(users, eq(users.id, bets.userId))
    .where(and(eq(bets.clubId, clubId), inArray(bets.status, ['won', 'lost']), eq(coupons.unit, 'points'), eq(users.isBot, false),
      gte(hands.settledAt, range.from), lt(hands.settledAt, range.to)))
    .groupBy(sql`1`); // by position: the tz is a bound parameter
  return rows.map((r) => ({ date: r.date, picks: r.picks, playedCents: Number(r.played), wonCents: Number(r.won) }));
}

async function flowDays(ctx: AppContext, clubId: string, tz: string, range: Range) {
  const day = clubDay(ledgerEntries.createdAt, tz);
  const rows = await ctx.db.select({
    date: day,
    sent: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${inArray(ledgerEntries.kind, [...SENT_KINDS])}), 0)`,
    claimed: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${inArray(ledgerEntries.kind, [...CLAIMED_KINDS])}), 0)`,
  }).from(ledgerEntries)
    .where(and(eq(ledgerEntries.clubId, clubId), inArray(ledgerEntries.kind, [...SENT_KINDS, ...CLAIMED_KINDS]),
      gte(ledgerEntries.createdAt, range.from), lt(ledgerEntries.createdAt, range.to)))
    .groupBy(sql`1`); // by position: the tz is a bound parameter
  return rows.map((r) => ({ date: r.date, sentCents: Number(r.sent), claimedCents: Number(r.claimed) }));
}

async function clubDays(ctx: AppContext, clubId: string, tz: string, range: Range): Promise<DayRow[]> {
  const play = await playDays(ctx, clubId, tz, range);
  const flow = await flowDays(ctx, clubId, tz, range);
  const dates = [...new Set([...play.map((p) => p.date), ...flow.map((f) => f.date)])];
  return dates.map((date) => {
    const p = play.find((x) => x.date === date);
    const f = flow.find((x) => x.date === date);
    return {
      date, picks: p?.picks ?? 0, playedCents: p?.playedCents ?? 0, wonCents: p?.wonCents ?? 0,
      sentCents: f?.sentCents ?? 0, claimedCents: f?.claimedCents ?? 0,
    };
  });
}

/**
 * GET /admin/financials/reconciliation: each club on its own club days (never added together),
 * plus each club's supply check (holdings − issued must be 0).
 */
export async function reconciliation(ctx: AppContext, requestedTz?: string, range?: Range) {
  const clubList = await activeClubs(ctx.db);
  const days = [];
  const checks = [];
  for (const club of clubList) {
    const tz = clubTz(club.settings, requestedTz);
    const window = range ?? lastDays(ctx.now(), RECONCILIATION_DAYS, tz);
    for (const d of await clubDays(ctx, club.id, tz, window)) {
      days.push({ ...d, clubId: club.id, clubName: club.name, resultCents: d.playedCents - d.wonCents });
    }
    const s = await supply(ctx.db, club.id);
    const wallets = await walletDrift(ctx.db, club.id);
    checks.push({
      clubId: club.id, clubName: club.name, drift: s.drift, issuedCents: s.issued, poolCents: s.pool, stocksCents: s.inStocks,
      walletsCents: s.inWallets, ridingCents: s.riding, tournamentsCents: s.inTournaments, driftingWallets: wallets.driftingCount,
    });
  }
  const sorted = [...days].sort((a, b) => b.date.localeCompare(a.date) || a.clubName.localeCompare(b.clubName));
  return { days: sorted, clubs: checks };
}

/** GET /admin/financials/daily-player-net: every real player who played today, per club. */
export async function dailyPlayerNet(ctx: AppContext, requestedTz?: string) {
  const clubList = await activeClubs(ctx.db);
  const players = [];
  for (const club of clubList) {
    const tz = clubTz(club.settings, requestedTz);
    const range: Range = { from: clubDayStart(ctx.now(), tz), to: new Date(ctx.now().getTime() + 1) };
    const play = await ctx.db.select({
      userId: bets.userId, username: users.username, displayName: users.displayName,
      played: sql<string>`coalesce(sum(${bets.stakeCents}), 0)`, won: sql<string>`coalesce(sum(${bets.payoutCents}), 0)`,
    }).from(bets)
      .innerJoin(hands, eq(hands.id, bets.handId)).innerJoin(coupons, eq(coupons.id, bets.couponId)).innerJoin(users, eq(users.id, bets.userId))
      .where(and(eq(bets.clubId, club.id), inArray(bets.status, ['won', 'lost']), eq(coupons.unit, 'points'), eq(users.isBot, false),
        gte(hands.settledAt, range.from), lt(hands.settledAt, range.to)))
      .groupBy(bets.userId, users.username, users.displayName);
    if (play.length === 0) continue;
    const ids = play.map((p) => p.userId);
    const flows = await ctx.db.select({
      userId: ledgerEntries.userId,
      in: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${inArray(ledgerEntries.kind, [...SENT_KINDS])}), 0)`,
      out: sql<string>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${inArray(ledgerEntries.kind, [...CLAIMED_KINDS])}), 0)`,
    }).from(ledgerEntries)
      .where(and(eq(ledgerEntries.clubId, club.id), inArray(ledgerEntries.userId, ids),
        gte(ledgerEntries.createdAt, range.from), lt(ledgerEntries.createdAt, range.to)))
      .groupBy(ledgerEntries.userId);
    const wallets = await ctx.db.select({ userId: pointAccounts.userId, balance: pointAccounts.balanceCents }).from(pointAccounts)
      .where(and(eq(pointAccounts.clubId, club.id), eq(pointAccounts.kind, 'player'), inArray(pointAccounts.userId, ids)));
    for (const p of play) {
      const f = flows.find((x) => x.userId === p.userId);
      const playedCents = Number(p.played);
      const wonCents = Number(p.won);
      players.push({
        userId: p.userId, name: p.displayName ?? p.username, clubId: club.id, clubName: club.name,
        inCents: Number(f?.in ?? 0), outCents: Number(f?.out ?? 0),
        balanceCents: wallets.find((w) => w.userId === p.userId)?.balance ?? 0,
        playedCents, wonCents, netCents: wonCents - playedCents,
      });
    }
  }
  return { players: [...players].sort((a, b) => b.playedCents - a.playedCents) };
}
