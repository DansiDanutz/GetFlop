import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { arenaPlayers, starOrders } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { arenaConfig, STAR_PACKS, type ArenaConfig, type StarPack } from './config.js';
import { starPaymentProvider } from './payments.js';
import { requirePlayer } from './players.js';
import { ensureArena } from './setup.js';
import { moveStars, starBalance, starWallet } from './stars.js';
import { dayStart, monthStart } from './time.js';

export type StarOrder = typeof starOrders.$inferSelect;
export type UnavailableReason = 'shop_closed' | 'cap_day' | 'cap_month' | 'checkout_open';

export const vatOf = (priceCents: number, cfg: ArenaConfig): number => Math.round((priceCents * cfg.vatPct) / 100);
export const totalOf = (pack: StarPack, cfg: ArenaConfig): number => pack.priceCents + vatOf(pack.priceCents, cfg);

/** Open checkouts older than the time-to-live no longer count (nor block a new one). */
async function expireStale(db: DbOrTx, now: Date, cfg: ArenaConfig): Promise<void> {
  await db.update(starOrders).set({ status: 'expired' })
    .where(and(eq(starOrders.status, 'open'), lt(starOrders.createdAt, new Date(now.getTime() - cfg.checkoutTtlMs))));
}

async function spentSince(db: DbOrTx, userId: string, since: Date): Promise<number> {
  const [row] = await db.select({ n: sql<string>`coalesce(sum(${starOrders.totalCents}), 0)` }).from(starOrders)
    .where(and(eq(starOrders.userId, userId), inArray(starOrders.status, ['open', 'paid']), gte(starOrders.createdAt, since)));
  return Number(row?.n ?? 0);
}

async function openOrder(db: DbOrTx, userId: string): Promise<StarOrder | null> {
  const [row] = await db.select().from(starOrders).where(and(eq(starOrders.userId, userId), eq(starOrders.status, 'open'))).limit(1);
  return row ?? null;
}

interface Caps { spentDay: number; spentMonth: number; leftDay: number; leftMonth: number }

async function caps(db: DbOrTx, userId: string, now: Date, cfg: ArenaConfig): Promise<Caps> {
  const spentDay = await spentSince(db, userId, dayStart(now, cfg.timeZone));
  const spentMonth = await spentSince(db, userId, monthStart(now, cfg.timeZone));
  return { spentDay, spentMonth, leftDay: Math.max(0, cfg.capDayCents - spentDay), leftMonth: Math.max(0, cfg.capMonthCents - spentMonth) };
}

function unavailable(total: number, c: Caps, cfg: ArenaConfig, hasOpen: boolean): UnavailableReason | null {
  if (!cfg.shopOpen) return 'shop_closed';
  if (hasOpen) return 'checkout_open';
  if (total > c.leftDay) return 'cap_day';
  if (total > c.leftMonth) return 'cap_month';
  return null;
}

/** GET /arena/packs: packs with availability and the spending caps. */
export async function packs(ctx: AppContext, userId: string) {
  const cfg = arenaConfig();
  const now = ctx.now();
  await expireStale(ctx.db, now, cfg);
  const c = await caps(ctx.db, userId, now, cfg);
  const pending = await openOrder(ctx.db, userId);
  const provider = starPaymentProvider();
  return {
    open: cfg.shopOpen,
    cardPayments: Boolean(provider),
    devPayments: provider?.name === 'dev',
    vatPct: cfg.vatPct,
    capDayCents: cfg.capDayCents, capMonthCents: cfg.capMonthCents,
    spentDayCents: c.spentDay, spentMonthCents: c.spentMonth, leftDayCents: c.leftDay, leftMonthCents: c.leftMonth,
    openOrderId: pending?.id ?? null,
    packs: STAR_PACKS.map((p) => {
      const reason = unavailable(totalOf(p, cfg), c, cfg, Boolean(pending));
      return {
        id: p.id, starsCents: p.starsCents, priceCents: p.priceCents, totalCents: totalOf(p, cfg), bonusPct: p.bonusPct ?? null,
        available: reason === null, unavailableReason: reason,
      };
    }),
  };
}

export interface CheckoutInput {
  readonly packId: string;
  readonly locale: string;
}

/** POST /arena/checkout: one open checkout at a time, within the daily and monthly caps. */
export async function checkout(ctx: AppContext, userId: string, input: CheckoutInput): Promise<{ url: string; orderId: string }> {
  const cfg = arenaConfig();
  if (!cfg.shopOpen) throw new AppError('arena.shop_closed', 409);
  const pack = STAR_PACKS.find((p) => p.id === input.packId);
  if (!pack) throw new AppError('arena.unknown_pack', 404);
  const provider = starPaymentProvider();
  if (!provider) throw new AppError('commerce.card_unavailable', 409);
  await ensureArena(ctx);
  const now = ctx.now();
  const total = totalOf(pack, cfg);
  const order = await ctx.db.transaction(async (tx) => {
    await requirePlayer(tx, userId);
    await tx.select({ id: arenaPlayers.userId }).from(arenaPlayers).where(eq(arenaPlayers.userId, userId)).for('update');
    await expireStale(tx, now, cfg);
    if (await openOrder(tx, userId)) throw new AppError('arena.checkout_open', 409);
    const c = await caps(tx, userId, now, cfg);
    if (total > c.leftDay) throw new AppError('arena.cap_day', 409, { left: c.leftDay, cap: cfg.capDayCents });
    if (total > c.leftMonth) throw new AppError('arena.cap_month', 409, { left: c.leftMonth, cap: cfg.capMonthCents });
    const [row] = await tx.insert(starOrders).values({
      userId, packId: pack.id, starsCents: pack.starsCents, priceCents: pack.priceCents, vatCents: vatOf(pack.priceCents, cfg),
      totalCents: total, provider: provider.name, locale: input.locale, createdAt: now,
    }).returning();
    return row!;
  });
  const back = `${ctx.config.publicAppUrl}/#/arena?order=${order.id}`;
  try {
    const session = await provider.createCheckout(ctx, {
      orderId: order.id, packId: pack.id, starsCents: pack.starsCents, totalCents: total, locale: input.locale,
      successUrl: `${back}&stars=success`, cancelUrl: `${back}&stars=cancel`,
    });
    await ctx.db.update(starOrders).set({ providerRef: session.ref }).where(eq(starOrders.id, order.id));
    return { url: session.url, orderId: order.id };
  } catch (err) {
    ctx.logger.error('Star checkout failed', err);
    await ctx.db.update(starOrders).set({ status: 'cancelled', cancelledAt: now }).where(eq(starOrders.id, order.id));
    throw new AppError('commerce.payments_failed', 502);
  }
}

async function ownOrder(db: DbOrTx, userId: string, orderId: string): Promise<StarOrder> {
  const [order] = await db.select().from(starOrders).where(and(eq(starOrders.id, orderId), eq(starOrders.userId, userId))).limit(1);
  if (!order) throw new AppError('arena.unknown_order', 404);
  return order;
}

export async function getOrder(ctx: AppContext, userId: string, orderId: string) {
  const o = await ownOrder(ctx.db, userId, orderId);
  return { id: o.id, packId: o.packId, starsCents: o.starsCents, totalCents: o.totalCents, status: o.status, paidAt: o.paidAt };
}

/** POST /arena/orders/:id/cancel: the player came back from the payment page without paying. */
export async function cancelOrder(ctx: AppContext, userId: string, orderId: string): Promise<{ status: string; charged: false }> {
  const order = await ownOrder(ctx.db, userId, orderId);
  if (order.status === 'paid') throw new AppError('arena.cancel_failed', 409);
  if (order.status === 'open') {
    await ctx.db.update(starOrders).set({ status: 'cancelled', cancelledAt: ctx.now() })
      .where(and(eq(starOrders.id, orderId), eq(starOrders.status, 'open')));
  }
  return { status: 'cancelled', charged: false };
}

/** Credits a paid order exactly once (called by the payment webhook, or the DEV simulator). */
export async function fulfilStarOrder(ctx: AppContext, orderId: string): Promise<StarOrder> {
  const paid = await ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(starOrders).where(eq(starOrders.id, orderId)).for('update');
    if (!order) throw new AppError('arena.unknown_order', 404);
    if (order.status === 'paid') return { order, credited: false };
    await moveStars(tx, {
      kind: 'purchase', from: null, to: starWallet(order.userId), amountCents: order.starsCents, userId: order.userId,
      refType: 'star_order', refId: order.id,
    });
    const [updated] = await tx.update(starOrders).set({ status: 'paid', paidAt: ctx.now() }).where(eq(starOrders.id, orderId)).returning();
    return { order: updated!, credited: true };
  });
  if (paid.credited) {
    const { clubId } = await ensureArena(ctx);
    const balanceCents = await starBalance(ctx.db, paid.order.userId);
    ctx.events.emit(rooms.user(paid.order.userId), 'balance:updated', { clubId, balanceCents, unit: 'stars' });
  }
  return paid.order;
}

/** DEV only: marks one of my own simulated orders as paid. */
export async function simulatePaid(ctx: AppContext, userId: string, orderId: string) {
  const order = await ownOrder(ctx.db, userId, orderId);
  if (!arenaConfig().devPayments || order.provider !== 'dev') throw new AppError('auth.forbidden', 403);
  if (order.status !== 'open' && order.status !== 'paid') throw new AppError('arena.unknown_order', 404);
  const paid = await fulfilStarOrder(ctx, orderId);
  return { id: paid.id, status: paid.status, starsCents: paid.starsCents, balanceCents: await starBalance(ctx.db, userId) };
}
