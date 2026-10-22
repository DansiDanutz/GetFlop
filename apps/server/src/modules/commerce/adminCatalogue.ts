import { and, asc, eq, isNotNull, max } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { DbOrTx, Tx } from '../../db/client.js';
import { clubBilling, clubs, commerceProducts, commerceVersions, type ProductKind } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { isEnforced } from './billing.js';
import { ensureCatalogue, versionInForce, versionsOf, type ProductRow, type VersionRow } from './catalogue.js';
import { addDays, DAY_MS } from './config.js';
import { usageOf, type Resource } from './limits.js';
import { accountMessage, audit } from './notify.js';

export const PRODUCT_KINDS: readonly ProductKind[] = ['club_level', 'diamond_pack', 'turnover_rate', 'point_rate', 'usage_rate'];
/** A play-charge rate change is announced at least this many days ahead. */
export const RATE_NOTICE_DAYS = 30;
const MAX_RATE_BP = 200;

export const productInput = z.object({
  code: z.string().trim().regex(/^[a-z0-9_]{2,40}$/),
  kind: z.enum(['club_level', 'diamond_pack', 'turnover_rate', 'point_rate', 'usage_rate']),
  nameEn: z.string().trim().min(1).max(80),
  nameEl: z.string().trim().min(1).max(80),
});

const limitsInput = z.object({
  members: z.number().int().min(0), ringGames: z.number().int().min(0), tournaments: z.number().int().min(0),
  rooms: z.number().int().min(0), broadcasts: z.number().int().min(0).nullable(),
});

export const draftInput = z.object({
  priceDiamonds: z.number().int().min(0).nullable().optional(),
  priceCents: z.number().int().min(1).nullable().optional(),
  diamonds: z.number().int().min(1).nullable().optional(),
  bonusPct: z.number().int().min(0).max(100).nullable().optional(),
  mostPopular: z.boolean().optional(),
  rateBp: z.number().int().min(0).max(MAX_RATE_BP).nullable().optional(),
  limits: limitsInput.nullable().optional(),
  effectiveFrom: z.iso.datetime({ offset: true }).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

async function productById(db: DbOrTx, id: string): Promise<ProductRow> {
  const [p] = await db.select().from(commerceProducts).where(eq(commerceProducts.id, id));
  if (!p) throw new AppError('commerce.product_not_found', 404);
  return p;
}

async function versionById(db: DbOrTx, id: string): Promise<{ version: VersionRow; product: ProductRow }> {
  const [v] = await db.select().from(commerceVersions).where(eq(commerceVersions.id, id));
  if (!v) throw new AppError('commerce.version_not_found', 404);
  return { version: v, product: await productById(db, v.productId) };
}

function assertDraft(v: VersionRow): void {
  if (v.status !== 'draft') throw new AppError('commerce.version_not_draft', 409);
}

/** Catalogue with each product's versions and what is in force / scheduled. */
export async function listCatalogue(db: DbOrTx, at: Date) {
  await ensureCatalogue(db);
  const products = await db.select().from(commerceProducts).orderBy(asc(commerceProducts.kind), asc(commerceProducts.sortOrder));
  const versions = await versionsOf(db, products.map((p) => p.id));
  const out = [];
  for (const p of products) {
    const inForce = await versionInForce(db, p.id, at);
    const mine = versions.filter((v) => v.productId === p.id);
    out.push({
      ...p, versions: mine, inForceVersionId: inForce?.id ?? null,
      scheduled: mine.filter((v) => v.status === 'published' && v.effectiveFrom && v.effectiveFrom > at).map((v) => v.id),
    });
  }
  return out;
}

export async function createProduct(ctx: AppContext, tx: Tx, actorId: string, input: z.infer<typeof productInput>) {
  await ensureCatalogue(tx);
  const [taken] = await tx.select({ id: commerceProducts.id }).from(commerceProducts).where(eq(commerceProducts.code, input.code));
  if (taken) throw new AppError('commerce.product_code_taken', 409);
  const [top] = await tx.select({ n: max(commerceProducts.sortOrder) }).from(commerceProducts).where(eq(commerceProducts.kind, input.kind));
  const [row] = await tx.insert(commerceProducts).values({ ...input, lifecycle: 'draft', sortOrder: (top?.n ?? -1) + 1, createdAt: ctx.now() }).returning();
  await audit(ctx, tx, actorId, 'product_created', { type: 'product', id: row!.id }, input);
  return row!;
}

export async function updateProduct(ctx: AppContext, tx: Tx, actorId: string, id: string, patch: { lifecycle?: 'draft' | 'active' | 'archived'; nameEn?: string; nameEl?: string }) {
  await productById(tx, id);
  const [row] = await tx.update(commerceProducts).set(patch).where(eq(commerceProducts.id, id)).returning();
  await audit(ctx, tx, actorId, 'product_updated', { type: 'product', id }, patch);
  return row!;
}

/** New draft, pre-filled from the latest version. */
export async function createDraft(ctx: AppContext, tx: Tx, actorId: string, productId: string) {
  await productById(tx, productId);
  const versions = await versionsOf(tx, [productId]);
  const latest = versions.at(-1);
  const [row] = await tx.insert(commerceVersions).values({
    productId, version: (latest?.version ?? 0) + 1, status: 'draft',
    priceDiamonds: latest?.priceDiamonds ?? null, priceCents: latest?.priceCents ?? null, diamonds: latest?.diamonds ?? null,
    bonusPct: latest?.bonusPct ?? null, mostPopular: latest?.mostPopular ?? false, rateBp: latest?.rateBp ?? null,
    limits: latest?.limits ?? null, createdBy: actorId, createdAt: ctx.now(),
  }).returning();
  await audit(ctx, tx, actorId, 'draft_created', { type: 'version', id: row!.id }, { productId, version: row!.version });
  return row!;
}

export async function saveDraft(ctx: AppContext, tx: Tx, actorId: string, id: string, input: z.infer<typeof draftInput>) {
  const { version } = await versionById(tx, id);
  assertDraft(version);
  const { effectiveFrom, ...rest } = input;
  const patch = { ...rest, ...(effectiveFrom !== undefined ? { effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null } : {}) };
  const [row] = await tx.update(commerceVersions).set(patch).where(eq(commerceVersions.id, id)).returning();
  await audit(ctx, tx, actorId, 'draft_saved', { type: 'version', id }, input);
  return row!;
}

export async function deleteDraft(ctx: AppContext, tx: Tx, actorId: string, id: string) {
  const { version } = await versionById(tx, id);
  assertDraft(version);
  await tx.delete(commerceVersions).where(eq(commerceVersions.id, id));
  await audit(ctx, tx, actorId, 'draft_deleted', { type: 'version', id }, { productId: version.productId, version: version.version });
  return { deleted: id };
}

function assertComplete(p: ProductRow, v: VersionRow): void {
  const ok = p.kind === 'club_level' ? v.priceDiamonds !== null && Boolean(v.limits)
    : p.kind === 'diamond_pack' ? Boolean(v.diamonds && v.priceCents)
      : p.kind === 'turnover_rate' ? v.rateBp !== null
        : v.priceDiamonds !== null;
  if (!ok) throw new AppError('commerce.version_incomplete');
}

const LIMIT_KEYS: readonly Resource[] = ['members', 'ringGames', 'tournaments', 'rooms', 'broadcasts'];

/** What publishing would change: price, limits, affected clubs, and the notice they get. */
export async function previewVersion(db: DbOrTx, id: string, at: Date) {
  const { version, product } = await versionById(db, id);
  const from = version.effectiveFrom ?? at;
  const current = await versionInForce(db, product.id, at);
  const base = { versionId: id, productId: product.id, kind: product.kind, from, version: version.version, currentVersion: current?.version ?? null };
  if (product.kind === 'turnover_rate') {
    const noticeOk = from.getTime() - at.getTime() >= RATE_NOTICE_DAYS * DAY_MS;
    return { ...base, rate: { fromBp: current?.rateBp ?? null, toBp: version.rateBp }, noticeOk, minNoticeDays: RATE_NOTICE_DAYS, notice: { code: 'rate_change', params: { from: from.toISOString(), fromBp: current?.rateBp ?? 0, toBp: version.rateBp ?? 0 } } };
  }
  if (product.kind !== 'club_level') {
    return { ...base, price: { fromCents: current?.priceCents ?? null, toCents: version.priceCents, fromD: current?.diamonds ?? null, toD: version.diamonds } };
  }
  const onLevel = await db.select().from(clubBilling).where(and(eq(clubBilling.levelCode, product.code), isNotNull(clubBilling.clubId)));
  const renewals = onLevel.map((b) => b.renewsAt).filter((d): d is Date => Boolean(d && d >= from)).sort((a, b) => a.getTime() - b.getTime());
  const limitsDiff = LIMIT_KEYS.filter((k) => current?.limits?.[k] !== version.limits?.[k])
    .map((k) => ({ resource: k, from: current?.limits?.[k] ?? null, to: version.limits?.[k] ?? null }));
  const overLimit = [];
  for (const b of onLevel) {
    const usage = await usageOf(db, b.clubId, at);
    const over = LIMIT_KEYS.filter((k) => { const l = version.limits?.[k]; return l !== null && l !== undefined && usage[k] > l; });
    if (over.length === 0) continue;
    const [club] = await db.select({ name: clubs.name }).from(clubs).where(eq(clubs.id, b.clubId));
    overLimit.push({ clubId: b.clubId, name: club?.name ?? '', resources: over });
  }
  return {
    ...base, price: { fromD: current?.priceDiamonds ?? null, toD: version.priceDiamonds },
    clubs: onLevel.length, firstRenewalAt: renewals[0] ?? null, limitsDiff, overLimit,
    notice: { code: 'price_change', params: { level: product.nameEn, from: from.toISOString(), fromD: current?.priceDiamonds ?? 0, toD: version.priceDiamonds ?? 0 } },
  };
}

export async function publishVersion(ctx: AppContext, tx: Tx, actorId: string, id: string) {
  const at = ctx.now();
  const { version, product } = await versionById(tx, id);
  assertDraft(version);
  assertComplete(product, version);
  const preview = await previewVersion(tx, id, at);
  if (product.kind === 'turnover_rate' && !('noticeOk' in preview && preview.noticeOk)) {
    throw new AppError('commerce.rate_notice_too_short', 409, { days: RATE_NOTICE_DAYS });
  }
  const [row] = await tx.update(commerceVersions).set({ status: 'published', publishedAt: at }).where(eq(commerceVersions.id, id)).returning();
  const billing = product.kind === 'club_level'
    ? await tx.select().from(clubBilling).where(eq(clubBilling.levelCode, product.code))
    : product.kind === 'turnover_rate' ? (await tx.select().from(clubBilling)).filter(isEnforced) : [];
  const notice = 'notice' in preview ? preview.notice : null;
  if (notice) for (const b of billing) await accountMessage(ctx, tx, b.clubId, notice.code, notice.params as unknown as Record<string, string | number>);
  await audit(ctx, tx, actorId, 'version_published', { type: 'version', id }, { productId: product.id, code: product.code, version: row!.version, notified: billing.length });
  return row!;
}

export async function withdrawVersion(ctx: AppContext, tx: Tx, actorId: string, id: string) {
  const { version, product } = await versionById(tx, id);
  if (version.status !== 'published') throw new AppError('commerce.version_not_published', 409);
  const [row] = await tx.update(commerceVersions).set({ status: 'withdrawn', withdrawnAt: ctx.now() }).where(eq(commerceVersions.id, id)).returning();
  await audit(ctx, tx, actorId, 'version_withdrawn', { type: 'version', id }, { productId: product.id, code: product.code, version: row!.version });
  return row!;
}

/** Earliest allowed effective date for a new play-charge rate. */
export const earliestRateChange = (at: Date): Date => addDays(at, RATE_NOTICE_DAYS);
