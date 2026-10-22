import type { AppContext } from '../../context.js';
import { AppError } from '../../http/errors.js';
import { assertCan, type ClubAccess } from '../clubs/access.js';
import { walletDrift } from '../points/ledger.js';
import { groupBy, marketStats, totals, weightedTheoHold, type Totals } from './metrics.js';
import { settledBets, userNames, type BetRowFact } from './queries.js';
import { currentOpenSession, findSession } from './sessions.js';
import { OPEN_END, type Range } from './time.js';

const DAY_MS = 86_400_000;

export interface AnalyticsQuery {
  readonly sessionId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly includeBots?: boolean;
  readonly source?: 'auto' | 'dealer';
  readonly dealerId?: string;
}

export interface Scope { readonly kind: 'session' | 'range' | 'last24h'; readonly sessionNumber: number | null; readonly range: Range }

async function scopeOf(ctx: AppContext, access: ClubAccess, q: AnalyticsQuery): Promise<Scope> {
  const now = ctx.now();
  const end = OPEN_END;
  if (q.sessionId) {
    const s = await findSession(ctx, access.club.id, q.sessionId);
    return { kind: 'session', sessionNumber: s.number, range: { from: s.openedAt, to: s.closedAt ?? end } };
  }
  if (q.from || q.to) {
    const from = q.from ? new Date(q.from) : new Date(0);
    const to = q.to ? new Date(q.to) : end;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new AppError('report.range_invalid');
    if (from.getTime() >= to.getTime()) throw new AppError('report.range_order');
    return { kind: 'range', sessionNumber: null, range: { from, to } };
  }
  const open = await currentOpenSession(ctx, access);
  if (open) return { kind: 'session', sessionNumber: open.number, range: { from: open.openedAt, to: end } };
  return { kind: 'last24h', sessionNumber: null, range: { from: new Date(now.getTime() - DAY_MS), to: end } };
}

type Row = Totals & { theoHoldPct: number | null };
const row = (bets: readonly BetRowFact[]): Row => ({ ...totals(bets), theoHoldPct: weightedTheoHold(bets) });

async function byDealer(ctx: AppContext, bets: readonly BetRowFact[]) {
  const key = (b: BetRowFact) => (b.dealtBy === 'auto' ? 'auto' : b.dealerId ?? 'unknown');
  const grouped = groupBy(bets, key);
  const names = await userNames(ctx.db, [...grouped.keys()]);
  return [...grouped.entries()].map(([k, list]) => ({
    dealerId: k === 'auto' || k === 'unknown' ? null : k,
    name: k === 'auto' ? null : names.get(k) ?? null,
    auto: k === 'auto',
    ...row(list),
  })).sort((a, b) => b.handleCents - a.handleCents);
}

function byTableRows(bets: readonly BetRowFact[]) {
  return [...groupBy(bets, (b) => b.tableId).entries()]
    .map(([tableId, list]) => ({ tableId, name: list[0]!.tableName, ...row(list) }))
    .sort((a, b) => b.handleCents - a.handleCents);
}

async function driftCheck(ctx: AppContext, clubId: string) {
  try {
    return { ok: true as const, ...(await walletDrift(ctx.db, clubId)) };
  } catch (err) {
    ctx.logger.error('Wallet drift check failed', err);
    return { ok: false as const };
  }
}

/** GET /inspector/analytics (07 §4.4): Ring Game handle, GGR and hold by market, dealer and table. */
export async function analytics(ctx: AppContext, access: ClubAccess, q: AnalyticsQuery) {
  assertCan(access, 'reports');
  const clubId = access.club.id;
  const scope = await scopeOf(ctx, access, q);
  const bets = await settledBets(ctx.db, clubId, {
    range: scope.range, unit: 'points', includeBots: q.includeBots, source: q.source, dealerId: q.dealerId,
  });
  const t = totals(bets);
  return {
    scope,
    handleCents: t.handleCents, ggrCents: t.resultCents, holdPct: t.holdPct, theoHoldPct: weightedTheoHold(bets),
    hands: t.hands, picks: t.picks, players: t.players,
    byMarket: marketStats(bets),
    byDealer: await byDealer(ctx, bets),
    byTable: byTableRows(bets),
    // Every hand records who dealt it; legacy "not recorded" hands do not exist here.
    notRecorded: 0,
    drift: await driftCheck(ctx, clubId),
  };
}
