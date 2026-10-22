import { MARKETS } from '@getflop/engine';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { betTypes, clubTables, sessions, users } from '../../db/schema/index.js';
import { deviceLabel } from '../auth/revocation.js';
import { clubDayStart, DEFAULT_TZ, type Range } from '../inspector/time.js';
import { supply } from '../points/ledger.js';
import { accountCounts } from './accounts.js';
import { listAudit } from './audit.js';
import {
  activeClubs, couponsBought, handsByClub, liveCoupons, marketTallies, openTables, playByClub, playersWhoPlayed, ridingByClub,
} from './figures.js';
import { presenceSnapshot } from './presence.js';
import { marketProbability, marketVerdict, wilsonInterval } from './stats.js';

const RECENT_AUDIT = 5;

async function health(ctx: AppContext) {
  const started = performance.now();
  await ctx.db.execute(sql`select 1`);
  return { dbMs: Math.round(performance.now() - started), connections: presenceSnapshot().connections };
}

/** Per club figures for the period; clubs are listed side by side, never summed. */
async function clubFigures(ctx: AppContext, range?: Range) {
  const [clubRows, play, handCounts, riding] = [
    await activeClubs(ctx.db), await playByClub(ctx.db, range), await handsByClub(ctx.db, range), await ridingByClub(ctx.db),
  ];
  return clubRows.map((c) => {
    const p = play.find((x) => x.clubId === c.id);
    const playedCents = p?.playedCents ?? 0;
    const wonCents = p?.wonCents ?? 0;
    return {
      clubId: c.id, name: c.name, publicId: c.publicId, hands: handCounts.get(c.id) ?? 0, players: p?.players ?? 0,
      picks: p?.picks ?? 0, playedCents, wonCents, resultCents: playedCents - wonCents, ridingCents: riding.get(c.id) ?? 0,
    };
  });
}

async function marketsReport(ctx: AppContext, range?: Range) {
  const tallies = await marketTallies(ctx.db, range);
  const catalogue = await ctx.db.select({ slug: betTypes.slug, name: betTypes.name, active: betTypes.active }).from(betTypes);
  return MARKETS.map((m) => {
    const t = tallies.find((x) => x.market === m.slug) ?? { picks: 0, hits: 0 };
    const probability = marketProbability(m.slug);
    const { low, high } = wilsonInterval(t.hits, t.picks);
    const row = catalogue.find((c) => c.slug === m.slug);
    return {
      slug: m.slug, name: row?.name ?? m.name, picks: t.picks, hits: t.hits,
      hitRate: t.picks > 0 ? t.hits / t.picks : 0, probability, low, high,
      verdict: marketVerdict(t.hits, t.picks, probability), retired: !(row?.active ?? false),
    };
  }).filter((m) => m.picks > 0 || !m.retired).sort((a, b) => b.picks - a.picks);
}

/** Each real account's latest device; the PWA flag is not recorded, so app installs are unknown (null). */
async function devicesReport(ctx: AppContext, tz: string) {
  const since = clubDayStart(ctx.now(), tz);
  const rows = await ctx.db.select({
    userId: users.id, username: users.username, displayName: users.displayName, userAgent: sessions.userAgent, signedInAt: sessions.createdAt,
  }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(users.isBot, false), eq(users.isActive, true))).orderBy(desc(sessions.createdAt));
  const latest = [...new Map(rows.map((r) => [r.userId, r])).values()];
  const list = latest.map((r) => ({
    userId: r.userId, name: r.displayName ?? r.username, device: deviceLabel(r.userAgent ?? undefined), app: null,
    signedInAt: r.signedInAt, signedInToday: r.signedInAt >= since,
  }));
  return { withApp: null, loginsToday: list.filter((d) => d.signedInToday).length, list };
}

async function tableNames(ctx: AppContext, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, { name: string; kind: string }>();
  const rows = await ctx.db.select({ id: clubTables.id, name: clubTables.name, kind: clubTables.kind }).from(clubTables)
    .where(inArray(clubTables.id, [...ids]));
  return new Map(rows.map((r) => [r.id, { name: r.name, kind: r.kind }]));
}

async function onlineNow(ctx: AppContext) {
  const snap = presenceSnapshot();
  const names = await tableNames(ctx, snap.byTable.map((t) => t.tableId));
  return {
    connected: snap.users, atTables: snap.atTables, lobby: snap.lobby,
    tables: snap.byTable.map((t) => ({ ...t, name: names.get(t.tableId)?.name ?? null, kind: names.get(t.tableId)?.kind ?? null })),
  };
}

/** GET /admin/platform: health, KPIs, online now, devices, clubs and markets for the period. */
export async function platformOverview(ctx: AppContext, range: Range | undefined, tz = DEFAULT_TZ) {
  const clubsList = await clubFigures(ctx, range);
  return {
    period: range ? { from: range.from, to: range.to } : null,
    health: await health(ctx),
    kpis: {
      handsDealt: clubsList.reduce((s, c) => s + c.hands, 0),
      clubsWithHands: clubsList.filter((c) => c.hands > 0).length,
      playersWhoPlayed: await playersWhoPlayed(ctx.db, range),
      couponsBought: await couponsBought(ctx.db, range),
      liveCoupons: await liveCoupons(ctx.db),
      clubs: clubsList.length,
      tablesOpen: await openTables(ctx.db),
    },
    online: await onlineNow(ctx),
    devices: await devicesReport(ctx, tz),
    clubs: clubsList,
    idleClubs: clubsList.filter((c) => c.hands === 0).length,
    markets: await marketsReport(ctx, range),
  };
}

/** GET /admin: the admin home. Today is the current club day in `tz`. */
export async function dashboard(ctx: AppContext, tz = DEFAULT_TZ) {
  const today: Range = { from: clubDayStart(ctx.now(), tz), to: new Date(ctx.now().getTime() + 1) };
  const clubsToday = await clubFigures(ctx, today);
  const checks = [];
  for (const c of clubsToday) checks.push({ clubId: c.clubId, name: c.name, drift: (await supply(ctx.db, c.clubId)).drift });
  const drifting = checks.filter((c) => c.drift !== 0);
  return {
    accounts: await accountCounts(ctx.db),
    clubs: clubsToday.length,
    today: {
      hands: clubsToday.reduce((s, c) => s + c.hands, 0),
      players: await playersWhoPlayed(ctx.db, today),
      coupons: await couponsBought(ctx.db, today),
    },
    todayClubs: clubsToday.filter((c) => c.hands > 0 || c.picks > 0),
    live: { liveCoupons: await liveCoupons(ctx.db), tablesOpen: await openTables(ctx.db), online: presenceSnapshot().users },
    driftingClubs: drifting,
    recentAudit: (await listAudit(ctx, { page: 1, limit: RECENT_AUDIT })).logs,
  };
}
