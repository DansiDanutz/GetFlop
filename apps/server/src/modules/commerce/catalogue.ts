import { and, asc, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import {
  commerceProducts, commerceSettings, commerceVersions, type LevelLimitsJson, type ProductKind,
} from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { CLUB_LEVELS } from './levels.js';

export type ProductRow = typeof commerceProducts.$inferSelect;
export type VersionRow = typeof commerceVersions.$inferSelect;

/** Default play charge: 1% of every Point played = 1 D per Point (a Point is rated 100 D). */
export const DEFAULT_RATE_BP = 100;
const EPOCH = new Date('2026-01-01T00:00:00Z');

interface DefaultProduct {
  readonly code: string;
  readonly kind: ProductKind;
  readonly nameEn: string;
  readonly nameEl: string;
  readonly sortOrder: number;
  readonly version: Partial<VersionRow>;
}

/** Diamond packs (the original list is unknown; these are GetFlop's defaults). Prices are net of VAT. */
const DEFAULT_PACKS = [
  { diamonds: 2_000, priceCents: 2_000, bonusPct: null, mostPopular: false },
  { diamonds: 5_000, priceCents: 5_000, bonusPct: null, mostPopular: true },
  { diamonds: 10_000, priceCents: 10_000, bonusPct: 5, mostPopular: false },
  { diamonds: 25_000, priceCents: 25_000, bonusPct: 10, mostPopular: false },
] as const;

const GREEK_LEVEL_NAME: Record<string, string> = { starter: 'Αρχικό' };

function defaultProducts(): DefaultProduct[] {
  const levels = CLUB_LEVELS.map((l, i): DefaultProduct => ({
    code: l.code, kind: 'club_level', nameEn: l.name, nameEl: GREEK_LEVEL_NAME[l.code] ?? l.name, sortOrder: i,
    version: {
      priceDiamonds: l.priceDiamonds,
      limits: { members: l.members, ringGames: l.ringGames, tournaments: l.tournaments, rooms: l.rooms, broadcasts: null },
    },
  }));
  const packs = DEFAULT_PACKS.map((p, i): DefaultProduct => ({
    code: `pack_${p.diamonds}`, kind: 'diamond_pack', nameEn: `${p.diamonds.toLocaleString('en-GB')} Diamonds`,
    nameEl: `${p.diamonds.toLocaleString('el-GR')} Διαμάντια`, sortOrder: i,
    version: { diamonds: p.diamonds, priceCents: p.priceCents, bonusPct: p.bonusPct, mostPopular: p.mostPopular },
  }));
  const rate: DefaultProduct = {
    code: 'play_charge', kind: 'turnover_rate', nameEn: 'Play charge', nameEl: 'Χρέωση παιχνιδιού', sortOrder: 0,
    version: { rateBp: DEFAULT_RATE_BP },
  };
  return [...levels, ...packs, rate];
}

const SEEDED_KEY = 'catalogue_seeded';

/** Seeds the default catalogue (version 1, published, on sale) once, the first time commerce is used. */
export async function ensureCatalogue(db: DbOrTx): Promise<void> {
  const [seeded] = await db.select().from(commerceSettings).where(eq(commerceSettings.key, SEEDED_KEY));
  if (seeded) return;
  for (const p of defaultProducts()) {
    const [product] = await db.insert(commerceProducts).values({
      code: p.code, kind: p.kind, nameEn: p.nameEn, nameEl: p.nameEl, sortOrder: p.sortOrder, lifecycle: 'active', createdAt: EPOCH,
    }).onConflictDoNothing().returning();
    if (!product) continue;
    await db.insert(commerceVersions).values({
      ...p.version, productId: product.id, version: 1, status: 'published', publishedAt: EPOCH, createdAt: EPOCH,
    });
  }
  await db.insert(commerceSettings).values({ key: SEEDED_KEY, value: true }).onConflictDoNothing();
}

/** The published version in force at `at` (latest effective), or null. */
export async function versionInForce(db: DbOrTx, productId: string, at: Date): Promise<VersionRow | null> {
  const [row] = await db.select().from(commerceVersions)
    .where(and(
      eq(commerceVersions.productId, productId), eq(commerceVersions.status, 'published'),
      or(isNull(commerceVersions.effectiveFrom), lte(commerceVersions.effectiveFrom, at)),
    ))
    .orderBy(desc(commerceVersions.version)).limit(1);
  return row ?? null;
}

export interface LevelOffer {
  readonly productId: string;
  readonly code: string;
  readonly name: string;
  readonly nameEl: string;
  readonly rank: number;
  readonly onSale: boolean;
  readonly versionId: string;
  readonly version: number;
  readonly priceD: number;
  readonly limits: LevelLimitsJson;
}

export async function productsOfKind(db: DbOrTx, kind: ProductKind): Promise<ProductRow[]> {
  await ensureCatalogue(db);
  return db.select().from(commerceProducts).where(eq(commerceProducts.kind, kind)).orderBy(asc(commerceProducts.sortOrder));
}

/** Every Level with a version in force, by rank. */
export async function levelOffers(db: DbOrTx, at: Date): Promise<LevelOffer[]> {
  const products = await productsOfKind(db, 'club_level');
  const out: LevelOffer[] = [];
  for (const p of products) {
    const v = await versionInForce(db, p.id, at);
    if (!v || !v.limits) continue;
    out.push({
      productId: p.id, code: p.code, name: p.nameEn, nameEl: p.nameEl, rank: p.sortOrder,
      onSale: p.lifecycle === 'active', versionId: v.id, version: v.version, priceD: v.priceDiamonds ?? 0, limits: v.limits,
    });
  }
  return out;
}

export async function levelOffer(db: DbOrTx, code: string, at: Date): Promise<LevelOffer | null> {
  return (await levelOffers(db, at)).find((l) => l.code === code || l.productId === code) ?? null;
}

export interface PackOffer {
  readonly productId: string;
  readonly code: string;
  readonly name: string;
  readonly nameEl: string;
  readonly versionId: string;
  readonly diamonds: number;
  readonly bonusDiamonds: number;
  readonly bonusPct: number | null;
  readonly priceCents: number;
  readonly mostPopular: boolean;
}

const bonusOf = (diamonds: number, pct: number | null): number => (pct ? Math.floor((diamonds * pct) / 100) : 0);

function toPack(p: ProductRow, v: VersionRow): PackOffer {
  const diamonds = v.diamonds ?? 0;
  return {
    productId: p.id, code: p.code, name: p.nameEn, nameEl: p.nameEl, versionId: v.id, diamonds,
    bonusDiamonds: bonusOf(diamonds, v.bonusPct), bonusPct: v.bonusPct, priceCents: v.priceCents ?? 0, mostPopular: v.mostPopular,
  };
}

/** Packs on sale now. */
export async function packOffers(db: DbOrTx, at: Date): Promise<PackOffer[]> {
  const products = (await productsOfKind(db, 'diamond_pack')).filter((p) => p.lifecycle === 'active');
  const out: PackOffer[] = [];
  for (const p of products) {
    const v = await versionInForce(db, p.id, at);
    if (v && v.diamonds && v.priceCents) out.push(toPack(p, v));
  }
  return out;
}

/** A pack by its version id; only the version in force of an on-sale pack can be bought. */
export async function packByVersion(db: DbOrTx, versionId: string, at: Date): Promise<PackOffer> {
  const offers = await packOffers(db, at);
  const pack = offers.find((o) => o.versionId === versionId);
  if (!pack) throw new AppError('commerce.pack_not_found', 404);
  return pack;
}

/** Play charge rate in force (percent × 100). */
export async function turnoverRateBp(db: DbOrTx, at: Date): Promise<number> {
  const [product] = (await productsOfKind(db, 'turnover_rate')).filter((p) => p.lifecycle === 'active');
  if (!product) return DEFAULT_RATE_BP;
  return (await versionInForce(db, product.id, at))?.rateBp ?? DEFAULT_RATE_BP;
}

/** A scheduled future rate change, if any ("from <at> the play charge goes a% → b%"). */
export async function scheduledRate(db: DbOrTx, at: Date): Promise<{ rateBp: number; from: Date } | null> {
  const [product] = await productsOfKind(db, 'turnover_rate');
  if (!product) return null;
  const rows = await db.select().from(commerceVersions)
    .where(and(eq(commerceVersions.productId, product.id), eq(commerceVersions.status, 'published')))
    .orderBy(asc(commerceVersions.effectiveFrom));
  const next = rows.find((v) => v.effectiveFrom && v.effectiveFrom > at);
  return next ? { rateBp: next.rateBp ?? DEFAULT_RATE_BP, from: next.effectiveFrom! } : null;
}

export async function versionsOf(db: DbOrTx, productIds: readonly string[]): Promise<VersionRow[]> {
  if (productIds.length === 0) return [];
  return db.select().from(commerceVersions).where(inArray(commerceVersions.productId, [...productIds]))
    .orderBy(asc(commerceVersions.version));
}
