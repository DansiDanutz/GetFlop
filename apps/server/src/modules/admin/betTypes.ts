import { MARKETS } from '@getflop/engine';
import { and, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { betTypes, couponLegs, coupons } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { AuthUser } from '../auth/session.js';
import type { BetTypeRow } from '../game/markets.js';
import { writeAudit } from './audit.js';
import { edgeOf, fairOdds, marketProbability, oddsToMultiplierX100 } from './stats.js';

const ODDS_DECIMALS = 100;
/** Highest price the editor accepts (X:1). */
export const MAX_PAYOUT_ODDS = 10_000;

export interface Impact {
  readonly liveCoupons: number;
  /** Unresolved Points still riding on the market (stake × unplayed rounds). */
  readonly unresolvedCents: number;
  readonly unresolvedByUnit: Readonly<Record<string, number>>;
}

/** Live coupons that include each market and what is still unresolved on it, per unit. */
async function impactByMarket(db: DbOrTx): Promise<Map<string, Impact>> {
  const rows = await db.select({
    market: couponLegs.market,
    unit: coupons.unit,
    liveCoupons: sql<number>`cast(count(distinct ${coupons.id}) as int)`,
    unresolved: sql<string>`coalesce(sum(${couponLegs.stakeCents} * (${coupons.rounds} - ${coupons.roundsSettled})), 0)`,
  }).from(couponLegs).innerJoin(coupons, eq(coupons.id, couponLegs.couponId))
    .where(and(eq(coupons.status, 'live'), eq(couponLegs.status, 'active')))
    .groupBy(couponLegs.market, coupons.unit);
  const out = new Map<string, Impact>();
  for (const r of rows) {
    const prev = out.get(r.market) ?? { liveCoupons: 0, unresolvedCents: 0, unresolvedByUnit: {} };
    const amount = Number(r.unresolved);
    out.set(r.market, {
      liveCoupons: prev.liveCoupons + r.liveCoupons,
      unresolvedCents: prev.unresolvedCents + (r.unit === 'points' ? amount : 0),
      unresolvedByUnit: { ...prev.unresolvedByUnit, [r.unit]: amount },
    });
  }
  return out;
}

const EMPTY_IMPACT: Impact = { liveCoupons: 0, unresolvedCents: 0, unresolvedByUnit: {} };
const round = (n: number, digits = 6) => Math.round(n * 10 ** digits) / 10 ** digits;

function view(row: BetTypeRow, impact: Impact) {
  const probability = marketProbability(row.slug);
  const payoutOdds = (row.multiplierX100 - ODDS_DECIMALS) / ODDS_DECIMALS;
  const fair = fairOdds(probability);
  return {
    slug: row.slug, name: row.name, category: row.category, payoutOdds, multiplier: row.multiplierX100 / ODDS_DECIMALS,
    probability: round(probability), fairOdds: round(fair, 4), fairMultiplier: round(fair + 1, 4),
    edge: round(edgeOf(payoutOdds, probability)), isActive: row.active, updatedAt: row.updatedAt,
    liveCoupons: impact.liveCoupons, unresolvedCents: impact.unresolvedCents,
  };
}

const ORDER = new Map(MARKETS.map((m, i) => [m.slug, i]));

export async function listBetTypes(ctx: AppContext) {
  const rows = await ctx.db.select().from(betTypes);
  const impacts = await impactByMarket(ctx.db);
  const sorted = [...rows].sort((a, b) => (ORDER.get(a.slug) ?? 999) - (ORDER.get(b.slug) ?? 999));
  return { betTypes: sorted.map((r) => view(r, impacts.get(r.slug) ?? EMPTY_IMPACT)) };
}

export interface BetTypeUpdate {
  readonly payoutOdds?: number;
  readonly multiplier?: number;
  readonly probability?: number;
  readonly fairOdds?: number;
  readonly isActive?: boolean;
}

function newMultiplierX100(input: BetTypeUpdate, current: number): number {
  if (input.payoutOdds !== undefined) {
    if (!(input.payoutOdds > 0 && input.payoutOdds <= MAX_PAYOUT_ODDS)) throw new AppError('admin.payout_invalid');
    return oddsToMultiplierX100(input.payoutOdds);
  }
  if (input.multiplier !== undefined) {
    if (!(input.multiplier > 1 && input.multiplier <= MAX_PAYOUT_ODDS + 1)) throw new AppError('admin.payout_invalid');
    return oddsToMultiplierX100(input.multiplier - 1);
  }
  if (input.isActive === undefined) throw new AppError('admin.payout_invalid');
  return current;
}

function assertChance(input: BetTypeUpdate): void {
  if (input.probability !== undefined && !(input.probability > 0 && input.probability < 1)) throw new AppError('admin.probability_invalid');
  if (input.fairOdds !== undefined && !(input.fairOdds > 0)) throw new AppError('admin.probability_invalid');
}

/**
 * Changes a market's price and/or board flag. Coupons already bought keep the multiplier
 * locked on their legs; only coupons bought afterwards use the new price.
 */
export async function updateBetType(ctx: AppContext, actor: AuthUser, slug: string, input: BetTypeUpdate) {
  assertChance(input);
  const [before] = await ctx.db.select().from(betTypes).where(eq(betTypes.slug, slug)).limit(1);
  if (!before) throw new AppError('admin.bet_type_not_found', 404);
  const multiplierX100 = newMultiplierX100(input, before.multiplierX100);
  const active = input.isActive ?? before.active;
  const updated = await ctx.db.transaction(async (tx) => {
    const [row] = await tx.update(betTypes).set({ multiplierX100, active, updatedAt: ctx.now() }).where(eq(betTypes.slug, slug)).returning();
    await writeAudit(tx, ctx.now(), {
      actorId: actor.id, action: 'bet_type_update', targetType: 'bet_type', targetId: slug,
      data: {
        before: { multiplierX100: before.multiplierX100, active: before.active },
        after: { multiplierX100, active },
        // The chance is computed exactly from the engine; a submitted value is only recorded.
        ...(input.probability !== undefined ? { submittedProbability: input.probability } : {}),
        ...(input.fairOdds !== undefined ? { submittedFairOdds: input.fairOdds } : {}),
      },
    });
    return row!;
  });
  const impact = (await impactByMarket(ctx.db)).get(slug) ?? EMPTY_IMPACT;
  const betType = view(updated, impact);
  const previous = view(before, impact);
  return {
    betType,
    previous: { payoutOdds: previous.payoutOdds, multiplier: previous.multiplier, edge: previous.edge, isActive: previous.isActive },
    impact,
    negativeEdge: betType.edge < 0,
  };
}
