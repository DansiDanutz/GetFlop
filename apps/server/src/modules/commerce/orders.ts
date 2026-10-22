import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { Tx } from '../../db/client.js';
import { clubs, diamondOrders, diamondRefunds, stripeEvents, topupRequests } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { ClubAccess } from '../clubs/access.js';
import { packByVersion } from './catalogue.js';
import { commerceConfig, DAY_MS, REFUND_WINDOW_DAYS } from './config.js';
import { accountMessage, alert, audit } from './notify.js';
import { settleOutstanding } from './playCharge.js';
import { reserveForCheckout, settleReservation } from './promo.js';
import { receipts } from './receipts.js';
import { createCheckoutSession, createRefund } from './stripe.js';
import { credit, takeBackFromOrder } from './wallet.js';

export type OrderRow = typeof diamondOrders.$inferSelect;

export const REFUND_GROUNDS = ['duplicate', 'not_credited', 'our_fault'] as const;

export interface CheckoutInput {
  readonly packVersionId: string;
  readonly locale: string;
  readonly promoCode?: string | null;
  readonly consent: boolean;
}

export interface CardPayments {
  readonly available: boolean;
  readonly provider: 'stripe' | 'dev' | null;
  readonly testMode: boolean;
}

export function cardPayments(): CardPayments {
  const cfg = commerceConfig();
  if (cfg.stripeSecretKey) return { available: true, provider: 'stripe', testMode: cfg.isTestMode };
  if (cfg.devPayments) return { available: true, provider: 'dev', testMode: true };
  return { available: false, provider: null, testMode: true };
}

const discounted = (listCents: number, pct: number | null): number => (pct ? Math.round((listCents * (100 - pct)) / 100) : listCents);

const returnUrl = (ctx: AppContext, orderId: string, result: string): string =>
  `${ctx.config.publicAppUrl}/#/club/account?order=${encodeURIComponent(orderId)}&result=${result}`;

/** Creates a pending order and, with Stripe configured, a Checkout Session to redirect to. */
export async function checkout(ctx: AppContext, access: ClubAccess, input: CheckoutInput) {
  if (!input.consent) throw new AppError('commerce.consent_required');
  const payments = cardPayments();
  if (!payments.available || !payments.provider) throw new AppError('commerce.payments_unavailable', 409);
  const at = ctx.now();
  const pack = await packByVersion(ctx.db, input.packVersionId, at);
  const order = await ctx.db.transaction(async (tx) => {
    const [created] = await tx.insert(diamondOrders).values({
      clubId: access.club.id, buyerId: access.user.id, packVersionId: pack.versionId,
      diamonds: pack.diamonds + pack.bonusDiamonds, listCents: pack.priceCents, netCents: pack.priceCents,
      provider: payments.provider!, isTest: payments.testMode, createdAt: at,
    }).returning();
    if (!input.promoCode?.trim()) return created!;
    const promo = await reserveForCheckout(tx, access.club.id, input.promoCode, pack.productId, created!.id, at);
    const [updated] = await tx.update(diamondOrders).set({
      promoCodeId: promo.id, discountPct: promo.value, netCents: discounted(pack.priceCents, promo.value),
    }).where(eq(diamondOrders.id, created!.id)).returning();
    return updated!;
  });
  if (payments.provider === 'dev') {
    return { orderId: order.id, url: returnUrl(ctx, order.id, 'dev'), dev: true, netCents: order.netCents };
  }
  try {
    const session = await createCheckoutSession(commerceConfig().stripeSecretKey!, {
      orderId: order.id, clubId: access.club.id, productName: `${pack.name} · ${access.club.name}`, amountCents: order.netCents,
      locale: input.locale, successUrl: returnUrl(ctx, order.id, 'success'), cancelUrl: returnUrl(ctx, order.id, 'cancel'),
      automaticTax: commerceConfig().stripeTax, customerEmail: access.user.email,
    });
    await ctx.db.update(diamondOrders).set({ stripeSessionId: session.id }).where(eq(diamondOrders.id, order.id));
    return { orderId: order.id, url: session.url, dev: false, netCents: order.netCents };
  } catch (err) {
    ctx.logger.error('Stripe checkout session failed', { orderId: order.id, err: err instanceof Error ? err.message : String(err) });
    await ctx.db.transaction(async (tx) => {
      await tx.update(diamondOrders).set({ status: 'failed', failureReason: 'session_failed' }).where(eq(diamondOrders.id, order.id));
      await settleReservation(tx, order.id, 'released');
    });
    throw new AppError('commerce.payments_failed', 502);
  }
}

export interface PaidAmounts {
  readonly subtotalCents: number;
  readonly totalCents: number;
  readonly vatCents: number;
  readonly currency: string;
  readonly paymentIntentId: string | null;
  readonly country: string | null;
}

const euros = (cents: number): string => (cents / 100).toFixed(2);

/**
 * Credits a paid order once. A paid amount that does not match the order credits nothing and
 * raises a payment_mismatch alert.
 */
export async function fulfilOrder(ctx: AppContext, tx: Tx, orderId: string, paid: PaidAmounts): Promise<'credited' | 'duplicate' | 'mismatch'> {
  const at = ctx.now();
  const [order] = await tx.select().from(diamondOrders).where(eq(diamondOrders.id, orderId)).for('update');
  if (!order) throw new AppError('commerce.order_not_found', 404);
  if (order.status !== 'pending') return 'duplicate';
  if (paid.subtotalCents !== order.netCents || paid.currency.toLowerCase() !== order.currency) {
    await tx.update(diamondOrders).set({
      status: 'failed', failureReason: 'amount_mismatch', paidSubtotalCents: paid.subtotalCents, totalCents: paid.totalCents,
      stripePaymentIntentId: paid.paymentIntentId,
    }).where(eq(diamondOrders.id, order.id));
    await settleReservation(tx, order.id, 'released');
    await alert(ctx, tx, 'payment_mismatch', { expectedCents: order.netCents, paidCents: paid.subtotalCents, currency: paid.currency }, { clubId: order.clubId, orderId: order.id });
    return 'mismatch';
  }
  const entry = await credit(tx, {
    clubId: order.clubId, type: 'topup', amount: order.diamonds, source: 'card', orderId: order.id, at,
    actorId: order.buyerId, refType: 'order', refId: order.id, data: { totalCents: paid.totalCents, method: order.provider },
  });
  const [club] = await tx.select({ name: clubs.name }).from(clubs).where(eq(clubs.id, order.clubId));
  const receipt = await receipts().issue({
    orderId: order.id, clubName: club?.name ?? '', productName: `${order.diamonds} D`, netCents: paid.subtotalCents,
    vatCents: paid.vatCents, totalCents: paid.totalCents, country: paid.country,
  });
  await tx.update(diamondOrders).set({
    status: 'paid', paidAt: at, paidSubtotalCents: paid.subtotalCents, totalCents: paid.totalCents, vatCents: paid.vatCents,
    country: paid.country, stripePaymentIntentId: paid.paymentIntentId, receiptStatus: receipt.status, receiptRef: receipt.ref,
  }).where(eq(diamondOrders.id, order.id));
  await settleReservation(tx, order.id, 'used');
  await settleOutstanding(ctx, tx, order.clubId);
  await accountMessage(ctx, tx, order.clubId, 'diamonds_added', {
    diamonds: order.diamonds, euros: euros(paid.totalCents), balance: entry.balanceAfter,
  });
  return 'credited';
}

/** DEV only: completes a dev order as if the card payment went through (no VAT). */
export async function simulatePayment(ctx: AppContext, access: ClubAccess, orderId: string) {
  if (!commerceConfig().devPayments) throw new AppError('commerce.payments_unavailable', 409);
  return ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(diamondOrders)
      .where(and(eq(diamondOrders.id, orderId), eq(diamondOrders.clubId, access.club.id)));
    if (!order || order.provider !== 'dev') throw new AppError('commerce.order_not_found', 404);
    const result = await fulfilOrder(ctx, tx, order.id, {
      subtotalCents: order.netCents, totalCents: order.netCents, vatCents: 0, currency: 'eur', paymentIntentId: null, country: null,
    });
    return { result };
  });
}

interface StripeObject { readonly [key: string]: unknown }
export interface StripeEvent { readonly id: string; readonly type: string; readonly data: { readonly object: StripeObject } }

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

async function orderForSession(tx: Tx, session: StripeObject): Promise<OrderRow | null> {
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const orderId = str(metadata.orderId) ?? str(session.client_reference_id);
  if (orderId) {
    const [byId] = await tx.select().from(diamondOrders).where(eq(diamondOrders.id, orderId));
    if (byId) return byId;
  }
  const sessionId = str(session.id);
  if (!sessionId) return null;
  const [bySession] = await tx.select().from(diamondOrders).where(eq(diamondOrders.stripeSessionId, sessionId));
  return bySession ?? null;
}

async function closeOrder(tx: Tx, order: OrderRow, status: 'expired' | 'failed', reason: string | null): Promise<void> {
  if (order.status !== 'pending') return;
  await tx.update(diamondOrders).set({ status, failureReason: reason }).where(eq(diamondOrders.id, order.id));
  await settleReservation(tx, order.id, 'released');
}

async function onSessionPaid(ctx: AppContext, tx: Tx, session: StripeObject): Promise<string> {
  if (str(session.payment_status) !== 'paid') return 'awaiting_payment';
  const order = await orderForSession(tx, session);
  if (!order) return 'not_ours';
  const details = (session.customer_details ?? {}) as Record<string, unknown>;
  const address = (details.address ?? {}) as Record<string, unknown>;
  const totalDetails = (session.total_details ?? {}) as Record<string, unknown>;
  return fulfilOrder(ctx, tx, order.id, {
    subtotalCents: int(session.amount_subtotal), totalCents: int(session.amount_total), vatCents: int(totalDetails.amount_tax),
    currency: str(session.currency) ?? '', paymentIntentId: str(session.payment_intent), country: str(address.country),
  });
}

/** Processes one verified Stripe event exactly once (event ids are recorded). */
export async function handleStripeEvent(ctx: AppContext, event: StripeEvent): Promise<{ handled: string }> {
  return ctx.db.transaction(async (tx) => {
    const [fresh] = await tx.insert(stripeEvents).values({ id: event.id, type: event.type, processedAt: ctx.now() })
      .onConflictDoNothing().returning();
    if (!fresh) return { handled: 'duplicate' };
    const object = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        return { handled: await onSessionPaid(ctx, tx, object) };
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed': {
        const order = await orderForSession(tx, object);
        if (order) await closeOrder(tx, order, event.type === 'checkout.session.expired' ? 'expired' : 'failed', event.type === 'checkout.session.expired' ? null : 'payment_failed');
        return { handled: order ? 'closed' : 'not_ours' };
      }
      case 'charge.dispute.created':
        await alert(ctx, tx, 'chargeback', {
          amountCents: int(object.amount), reason: str(object.reason), paymentIntent: str(object.payment_intent),
        });
        return { handled: 'alerted' };
      default:
        return { handled: 'ignored' };
    }
  });
}

/** Platform refund: the whole card payment goes back; the purchase's unspent Diamonds are taken back. */
export async function refundOrder(ctx: AppContext, actorId: string, orderId: string, ground: string) {
  if (!(REFUND_GROUNDS as readonly string[]).includes(ground)) throw new AppError('commerce.refund_ground_invalid');
  const at = ctx.now();
  const [order] = await ctx.db.select().from(diamondOrders).where(eq(diamondOrders.id, orderId));
  if (!order) throw new AppError('commerce.order_not_found', 404);
  if (order.status !== 'paid' || !order.paidAt) throw new AppError('commerce.refund_not_refundable', 409);
  if (at.getTime() - order.paidAt.getTime() > REFUND_WINDOW_DAYS * DAY_MS) {
    throw new AppError('commerce.refund_window_closed', 409, { days: REFUND_WINDOW_DAYS });
  }
  const refundCents = order.totalCents ?? order.netCents;
  let stripeRefundId: string | null = null;
  if (order.provider === 'stripe') {
    const key = commerceConfig().stripeSecretKey;
    if (!key || !order.stripePaymentIntentId) throw new AppError('commerce.refund_failed', 502);
    try {
      stripeRefundId = (await createRefund(key, order.stripePaymentIntentId, order.id)).id;
    } catch (err) {
      ctx.logger.error('Stripe refund failed', { orderId, err: err instanceof Error ? err.message : String(err) });
      throw new AppError('commerce.refund_failed', 502);
    }
  }
  return ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(diamondOrders).where(eq(diamondOrders.id, orderId)).for('update');
    if (locked?.status !== 'paid') throw new AppError('commerce.refund_not_refundable', 409);
    const taken = await takeBackFromOrder(tx, {
      clubId: order.clubId, type: 'refund', orderId: order.id, amount: order.diamonds, at, actorId,
      refType: 'order', refId: order.id, data: { ground, refundCents },
    });
    const short = order.diamonds - taken;
    const note = await receipts().creditNote({
      orderId: order.id, clubName: '', productName: `${order.diamonds} D`, netCents: order.paidSubtotalCents ?? order.netCents,
      vatCents: order.vatCents ?? 0, totalCents: refundCents, country: order.country,
    }, stripeRefundId ?? order.id);
    const [refund] = await tx.insert(diamondRefunds).values({
      orderId: order.id, clubId: order.clubId, ground, amountCents: refundCents, diamondsTakenBack: taken, diamondsShort: short,
      stripeRefundId, creditNoteStatus: note.status, actorId, createdAt: at,
    }).returning();
    await tx.update(diamondOrders).set({ status: 'refunded', refundedAt: at }).where(eq(diamondOrders.id, order.id));
    if (short > 0) await alert(ctx, tx, 'refund_short', { shortD: short, takenD: taken }, { clubId: order.clubId, orderId: order.id });
    await accountMessage(ctx, tx, order.clubId, 'card_refund', { euros: euros(refundCents), diamonds: taken });
    await audit(ctx, tx, actorId, 'refund', { type: 'order', id: order.id }, { ground, refundCents, taken, short });
    return { refundId: refund!.id, refundCents, diamondsTakenBack: taken, diamondsShort: short };
  });
}

export interface TopupInput {
  readonly diamonds: number;
  readonly reference: string;
  readonly note?: string | null;
  readonly requestId?: string | null;
}

/** Admin top-up (bank transfer / invoice). Unpaid charges are settled first. */
export async function adminTopup(ctx: AppContext, tx: Tx, actorId: string, clubId: string, input: TopupInput) {
  if (!Number.isInteger(input.diamonds) || input.diamonds <= 0) throw new AppError('commerce.topup_amount_invalid');
  if (!input.reference?.trim()) throw new AppError('commerce.topup_reference_required');
  const at = ctx.now();
  if (input.requestId) {
    const [request] = await tx.select().from(topupRequests)
      .where(and(eq(topupRequests.id, input.requestId), eq(topupRequests.clubId, clubId), eq(topupRequests.status, 'pending')));
    if (!request) throw new AppError('commerce.topup_request_not_found', 404);
    await tx.update(topupRequests).set({ status: 'done', resolvedBy: actorId, resolvedAt: at }).where(eq(topupRequests.id, request.id));
  }
  await credit(tx, {
    clubId, type: 'topup', amount: input.diamonds, source: 'topup', at, actorId, refType: 'manual',
    refId: input.requestId ?? null, note: input.note ?? null, data: { reference: input.reference.trim() },
  });
  const settled = await settleOutstanding(ctx, tx, clubId);
  const [club] = await tx.select({ balance: clubs.diamondsBalance }).from(clubs).where(eq(clubs.id, clubId));
  await accountMessage(ctx, tx, clubId, 'diamonds_added_manual', { diamonds: input.diamonds, balance: club?.balance ?? 0 });
  await audit(ctx, tx, actorId, 'topup', { type: 'club', id: clubId }, { diamonds: input.diamonds, reference: input.reference.trim(), settled });
  return { diamonds: input.diamonds, balanceD: club?.balance ?? 0, settledCharges: settled };
}

export async function requestTopup(ctx: AppContext, access: ClubAccess, packVersionId: string) {
  const pack = await packByVersion(ctx.db, packVersionId, ctx.now());
  const [existing] = await ctx.db.select().from(topupRequests)
    .where(and(eq(topupRequests.clubId, access.club.id), eq(topupRequests.status, 'pending')));
  if (existing) return { requestId: existing.id, diamonds: existing.diamonds, createdAt: existing.createdAt };
  const [row] = await ctx.db.insert(topupRequests).values({
    clubId: access.club.id, packVersionId: pack.versionId, diamonds: pack.diamonds + pack.bonusDiamonds,
    requestedBy: access.user.id, createdAt: ctx.now(),
  }).returning();
  return { requestId: row!.id, diamonds: row!.diamonds, createdAt: row!.createdAt };
}

export async function rejectTopupRequest(ctx: AppContext, tx: Tx, actorId: string, requestId: string) {
  const [row] = await tx.update(topupRequests).set({ status: 'rejected', resolvedBy: actorId, resolvedAt: ctx.now() })
    .where(and(eq(topupRequests.id, requestId), eq(topupRequests.status, 'pending'))).returning();
  if (!row) throw new AppError('commerce.topup_request_not_found', 404);
  await accountMessage(ctx, tx, row.clubId, 'topup_request_rejected', { diamonds: row.diamonds });
  await audit(ctx, tx, actorId, 'topup_request_rejected', { type: 'topup_request', id: row.id });
  return { requestId: row.id, status: row.status };
}

export async function retryReceipt(ctx: AppContext, orderId: string) {
  const [order] = await ctx.db.select().from(diamondOrders).where(eq(diamondOrders.id, orderId));
  if (!order) throw new AppError('commerce.order_not_found', 404);
  if (order.status !== 'paid' && order.status !== 'refunded') throw new AppError('commerce.refund_not_refundable', 409);
  const [club] = await ctx.db.select({ name: clubs.name }).from(clubs).where(eq(clubs.id, order.clubId));
  const receipt = await receipts().issue({
    orderId: order.id, clubName: club?.name ?? '', productName: `${order.diamonds} D`, netCents: order.paidSubtotalCents ?? order.netCents,
    vatCents: order.vatCents ?? 0, totalCents: order.totalCents ?? order.netCents, country: order.country,
  });
  await ctx.db.update(diamondOrders).set({ receiptStatus: receipt.status, receiptRef: receipt.ref }).where(eq(diamondOrders.id, order.id));
  return { receiptStatus: receipt.status };
}
