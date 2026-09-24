import { MARKETS } from '@getflop/engine';
import type { DbOrTx } from './client.js';
import { betTypes } from './schema/index.js';

/** Inserts the market catalogue with engine defaults; existing prices are kept. */
export async function seedBetTypes(db: DbOrTx): Promise<void> {
  await db
    .insert(betTypes)
    .values(MARKETS.map((m) => ({
      slug: m.slug, name: m.name, category: m.group,
      multiplierX100: Math.round(m.multiplier * 100), active: m.enabledByDefault,
    })))
    .onConflictDoNothing();
}
