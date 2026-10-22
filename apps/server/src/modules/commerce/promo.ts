import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx, Tx } from '../../db/client.js';
import { clubs, commerceProducts, promoCodes, promoRedemptions } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { addDays } from './config.js';
import { accountMessage, audit } from './notify.js';
import { settleOutstanding } from './playCharge.js';
import { credit } from './wallet.js';

export type PromoRow = typeof promoCodes.$inferSelect;

const CODE_PATTERN = /^[A-Za-z0-9-]{4,24}$/;
const GENERATED_LENGTH = 8;
const GENERATED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_USES = 10_000;
const MAX_DAYS = 365;
const MAX_GIFT_D = 1_000_000;

export interface PromoInput {
  readonly code?: string | null;
  readonly kind: string;
  readonly value: number;
  readonly packId?: string | null;
  readonly clubId?: string | null;
  readonly days: number;
  readonly uses: number;
}

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(GENERATED_LENGTH));
  return Array.from(bytes, (b) => GENERATED_ALPHABET[b % GENERATED_ALPHABET.length]).join('');
}

async function validatePromo(db: DbOrTx, input: PromoInput): Promise<string> {
  if (input.kind !== 'gift' && input.kind !== 'percent') throw new AppError('commerce.promo_kind_invalid');
  const valueOk = Number.isInteger(input.value) && (input.kind === 'percent'
    ? input.value >= 1 && input.value <= 99 : input.value >= 1 && input.value <= MAX_GIFT_D);
  if (!valueOk) throw new AppError('commerce.promo_value_invalid');
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_DAYS) throw new AppError('commerce.promo_days_invalid');
  if (!Number.isInteger(input.uses) || input.uses < 1 || input.uses > MAX_USES) throw new AppError('commerce.promo_uses_invalid');
  if (input.clubId) {
    const [club] = await db.select({ id: clubs.id }).from(clubs).where(eq(clubs.id, input.clubId));
    if (!club) throw new AppError('commerce.promo_club_invalid');
  }
  if (input.kind === 'percent' && input.packId) {
    const [pack] = await db.select().from(commerceProducts).where(eq(commerceProducts.id, input.packId));
    if (!pack || pack.kind !== 'diamond_pack') throw new AppError('commerce.promo_pack_invalid');
  }
  const code = input.code?.trim() ? input.code.trim().toUpperCase() : generateCode();
  if (!CODE_PATTERN.test(code)) throw new AppError('commerce.promo_code_invalid');
  const [taken] = await db.select({ id: promoCodes.id }).from(promoCodes).where(sql`upper(${promoCodes.code}) = ${code}`);
  if (taken) throw new AppError('commerce.promo_code_taken', 409);
  return code;
}

export async function createPromo(ctx: AppContext, tx: Tx, actorId: string, input: PromoInput): Promise<PromoRow> {
  const code = await validatePromo(tx, input);
  const at = ctx.now();
  const [row] = await tx.insert(promoCodes).values({
    code, kind: input.kind, value: input.value, packProductId: input.kind === 'percent' ? input.packId ?? null : null,
    clubId: input.clubId ?? null, maxUses: input.uses, expiresAt: addDays(at, input.days), createdBy: actorId, createdAt: at,
  }).returning();
  if (row!.clubId) {
    await accountMessage(ctx, tx, row!.clubId, 'promo_received', {
      code, kind: row!.kind, value: row!.value, until: row!.expiresAt.toISOString(),
    });
  }
  await audit(ctx, tx, actorId, 'code_created', { type: 'promo_code', id: row!.id }, { code, kind: row!.kind, value: row!.value, clubId: row!.clubId });
  return row!;
}

export async function disablePromo(ctx: AppContext, tx: Tx, actorId: string, id: string): Promise<PromoRow> {
  const [row] = await tx.update(promoCodes).set({ status: 'withdrawn', withdrawnAt: ctx.now() }).where(eq(promoCodes.id, id)).returning();
  if (!row) throw new AppError('commerce.promo_not_found', 404);
  await audit(ctx, tx, actorId, 'code_withdrawn', { type: 'promo_code', id }, { code: row.code });
  return row;
}

/** Counts of live redemptions (used + reserved at checkout) per code. */
async function redemptionCounts(db: DbOrTx, codeIds: readonly string[]) {
  if (codeIds.length === 0) return [];
  return db.select({ codeId: promoRedemptions.codeId, state: promoRedemptions.state, n: sql<number>`count(*)::int` })
    .from(promoRedemptions).where(inArray(promoRedemptions.codeId, [...codeIds]))
    .groupBy(promoRedemptions.codeId, promoRedemptions.state);
}

export function promoStatus(row: PromoRow, taken: number, at: Date): string {
  if (row.status === 'withdrawn') return 'withdrawn';
  if (row.expiresAt <= at) return 'expired';
  if (taken >= row.maxUses) return 'used_up';
  return 'active';
}

export async function listPromos(db: DbOrTx, at: Date) {
  const rows = await db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt));
  const counts = await redemptionCounts(db, rows.map((r) => r.id));
  const of = (id: string, state: string) => counts.find((c) => c.codeId === id && c.state === state)?.n ?? 0;
  return rows.map((r) => {
    const used = of(r.id, 'used');
    const reserved = of(r.id, 'reserved');
    return {
      id: r.id, code: r.code, kind: r.kind, value: r.value, packId: r.packProductId, clubId: r.clubId,
      maxUses: r.maxUses, expiresAt: r.expiresAt, createdAt: r.createdAt, status: promoStatus(r, used + reserved, at),
      redemptions: { used, reserved, released: of(r.id, 'released') },
    };
  });
}

/** Finds a code usable by this club, or throws the redemption error the owner sees. */
export async function usableCode(db: DbOrTx, clubId: string, rawCode: string, at: Date): Promise<PromoRow> {
  const code = rawCode.trim().toUpperCase();
  const [row] = await db.select().from(promoCodes).where(sql`upper(${promoCodes.code}) = ${code}`);
  if (!row || (row.clubId && row.clubId !== clubId)) throw new AppError('commerce.promo_not_found', 404);
  if (row.status === 'withdrawn') throw new AppError('commerce.promo_inactive', 409);
  if (row.expiresAt <= at) throw new AppError('commerce.promo_expired', 409, { date: row.expiresAt.toISOString() });
  const live = await db.select().from(promoRedemptions)
    .where(and(eq(promoRedemptions.codeId, row.id), ne(promoRedemptions.state, 'released')));
  if (live.some((r) => r.clubId === clubId)) throw new AppError('commerce.promo_already_used', 409);
  if (live.length >= row.maxUses) throw new AppError('commerce.promo_used_up', 409);
  return row;
}

export async function checkPromo(db: DbOrTx, clubId: string, code: string, at: Date) {
  const row = await usableCode(db, clubId, code, at);
  return row.kind === 'gift'
    ? { kind: 'gift', code: row.code, giftD: row.value }
    : { kind: 'percent', code: row.code, pct: row.value, packId: row.packProductId };
}

/** "Add the Diamonds": a gift code credits free Diamonds (ledger grant, no payment, no receipt). */
export async function redeemGift(ctx: AppContext, tx: Tx, clubId: string, actorId: string, code: string) {
  const at = ctx.now();
  const row = await usableCode(tx, clubId, code, at);
  if (row.kind !== 'gift') throw new AppError('commerce.promo_card_only', 409);
  await tx.insert(promoRedemptions).values({ codeId: row.id, clubId, state: 'used', createdAt: at });
  const entry = await credit(tx, {
    clubId, type: 'grant', amount: row.value, source: 'grant', at, actorId, refType: 'promo_code', refId: row.id,
    data: { code: row.code },
  });
  await settleOutstanding(ctx, tx, clubId);
  return { giftD: row.value, balanceD: entry.balanceAfter };
}

/** Percent code at card checkout: validated against the pack and reserved for the order. */
export async function reserveForCheckout(tx: Tx, clubId: string, code: string, packProductId: string, orderId: string, at: Date): Promise<PromoRow> {
  const row = await usableCode(tx, clubId, code, at);
  if (row.kind !== 'percent') throw new AppError('commerce.promo_gift_not_here', 409);
  if (row.packProductId && row.packProductId !== packProductId) throw new AppError('commerce.promo_wrong_pack', 409);
  await tx.insert(promoRedemptions).values({ codeId: row.id, clubId, orderId, state: 'reserved', createdAt: at });
  return row;
}

export async function settleReservation(tx: DbOrTx, orderId: string, state: 'used' | 'released'): Promise<void> {
  await tx.update(promoRedemptions).set({ state })
    .where(and(eq(promoRedemptions.orderId, orderId), eq(promoRedemptions.state, 'reserved')));
}
