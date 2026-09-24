import { MARKETS, type TableLimits } from '@getflop/engine';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { betTypes, type TableLimitsJson } from '../../db/schema/index.js';

export type BetTypeRow = typeof betTypes.$inferSelect;

/** The platform catalogue: current multiplier and active flag per market. */
export async function catalogue(db: DbOrTx): Promise<Map<string, BetTypeRow>> {
  const rows = await db.select().from(betTypes);
  return new Map(rows.map((r) => [r.slug, r]));
}

export async function activeSlugs(db: DbOrTx): Promise<string[]> {
  return (await db.select({ slug: betTypes.slug }).from(betTypes).where(eq(betTypes.active, true))).map((r) => r.slug);
}

/** Markets offered at a table: its explicit list (∩ active), or every active market when empty. */
export function offeredAt(tableMarkets: readonly string[], cat: Map<string, BetTypeRow>): Set<string> {
  const active = [...cat.values()].filter((b) => b.active).map((b) => b.slug);
  return new Set(tableMarkets.length === 0 ? active : tableMarkets.filter((s) => cat.get(s)?.active));
}

/** Catalogue ordered as the engine lists it, with the price in force. */
export function marketList(cat: Map<string, BetTypeRow>, offered: ReadonlySet<string>) {
  return MARKETS.filter((m) => offered.has(m.slug)).map((m) => ({
    slug: m.slug,
    name: m.name,
    group: m.group,
    multiplier: (cat.get(m.slug)?.multiplierX100 ?? Math.round(m.multiplier * 100)) / 100,
  }));
}

export const toEngineLimits = (l: TableLimitsJson): TableLimits => ({ ...l, marketMaxCents: l.marketMaxCents ?? {} });
