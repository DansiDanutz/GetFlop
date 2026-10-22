import { and, eq, isNull } from 'drizzle-orm';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { accountMessages, diamondOrders, diamondRefunds } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { can, requireClub, type ClubAccess } from '../clubs/access.js';
import { getBilling, updateBilling } from './billing.js';
import { packOffers } from './catalogue.js';
import { DAY_MS } from './config.js';
import { chargesPage, clubState, dashboard, ledgerPage } from './dashboard.js';
import { idempotencyKey, once } from './idempotency.js';
import { cancelDowngrade, quoteLevel, scheduleDowngrade, upgradeLevel } from './levelChange.js';
import { checkout, requestTopup, simulatePayment } from './orders.js';
import { checkPromo, redeemGift } from './promo.js';
import { receipts } from './receipts.js';

const PAGE_MAX = 100;
const NOTICE_SNOOZE_MS = DAY_MS;

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
});
const codeBody = z.object({ code: z.string().trim().min(1).max(40) });
const productBody = z.object({ productId: z.string().min(1) });
const channel = z.object({ inApp: z.boolean(), email: z.boolean() });
const prefsBody = z.object({
  lowBalance: channel,
  usageSummary: channel.extend({ cadence: z.enum(['daily', 'weekly']) }),
});

/** The owner's Club account: owner only (platform admins pass through `billing`). */
async function requireOwner(ctx: AppContext, req: Request): Promise<ClubAccess> {
  const access = await requireClub(ctx.db, req, currentUser(req), 'view');
  if (!can(access, 'billing')) throw new AppError('commerce.forbidden', 403);
  return access;
}

/** Full-screen Diamond notice card for the owner, when one is due and not recently shown. */
function noticeKind(state: string, balance: number, enforced: boolean): string | null {
  if (!enforced) return null;
  if (state === 'restricted') return 'paused';
  if (state === 'past_due_grace') return 'renewal_overdue';
  if (state === 'usage_grace') return 'pending';
  if (balance <= 0) return 'empty';
  if (state === 'critical') return 'almost_gone';
  if (state === 'low') return 'low';
  return null;
}

export function clubCommerceRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/state', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    const s = await clubState(ctx.db, access.club.id, ctx.now());
    return { balanceD: s.balanceD, state: s.state, mode: s.enforced ? 'enforced' : 'pilot', pendingD: s.pendingD, level: s.billing.levelCode };
  }));

  r.get('/dashboard', handle(async (req) => dashboard(ctx.db, (await requireOwner(ctx, req)).club.id, ctx.now())));

  r.get('/charges', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    const q = pageQuery.parse(req.query);
    return { charges: await chargesPage(ctx.db, access.club.id, q.limit, q.before ? new Date(q.before) : undefined) };
  }));

  r.get('/ledger', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    const q = pageQuery.parse(req.query);
    return { entries: await ledgerPage(ctx.db, access.club.id, q.limit, q.before ? new Date(q.before) : undefined) };
  }));

  r.get('/packs', handle(async (req) => {
    await requireOwner(ctx, req);
    return { packs: await packOffers(ctx.db, ctx.now()) };
  }));

  r.get('/notice', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    const s = await clubState(ctx.db, access.club.id, ctx.now());
    const kind = noticeKind(s.state, s.balanceD, s.enforced);
    const b = s.billing;
    const snoozed = kind && b.noticeShownKind === kind && b.noticeShownAt && ctx.now().getTime() - b.noticeShownAt.getTime() < NOTICE_SNOOZE_MS;
    return { notice: kind && !snoozed ? { kind, balanceD: s.balanceD, pendingD: s.pendingD, perDayD: s.perDay, deadline: b.renewalDeadline } : null };
  }));

  r.post('/notice/shown', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    const { kind } = z.object({ kind: z.string() }).parse(req.body ?? {});
    if (kind !== 'diamonds') throw new AppError('commerce.notice_unknown');
    const s = await clubState(ctx.db, access.club.id, ctx.now());
    await updateBilling(ctx.db, access.club.id, { noticeShownAt: ctx.now(), noticeShownKind: noticeKind(s.state, s.balanceD, s.enforced) }, ctx.now());
    return { ok: true };
  }));

  r.post('/notifications/read', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    await ctx.db.update(accountMessages).set({ readAt: ctx.now() })
      .where(and(eq(accountMessages.clubId, access.club.id), isNull(accountMessages.readAt)));
    return { ok: true };
  }));

  r.put('/notification-preferences', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    const prefs = prefsBody.parse(req.body);
    const billing = await getBilling(ctx.db, access.club.id, ctx.now());
    const row = await updateBilling(ctx.db, access.club.id, { prefs: { ...billing.prefs, ...prefs } }, ctx.now());
    return { prefs: row.prefs };
  }));

  r.post('/promo/check', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    return checkPromo(ctx.db, access.club.id, codeBody.parse(req.body).code, ctx.now());
  }));

  r.post('/promo/redeem', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    const { code } = codeBody.parse(req.body);
    return ctx.db.transaction((tx) => redeemGift(ctx, tx, access.club.id, access.user.id, code));
  }));

  r.post('/topup-request', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    const { packVersionId } = z.object({ packVersionId: z.string().min(1) }).parse(req.body);
    return requestTopup(ctx, access, packVersionId);
  }));

  r.post('/checkout', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    const body = z.object({
      packVersionId: z.string().min(1), locale: z.string().max(10).default('en'),
      promoCode: z.string().max(40).nullable().optional(), consent: z.boolean().default(false),
    }).parse(req.body);
    return checkout(ctx, access, body);
  }));

  r.get('/orders/:id', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    const [order] = await ctx.db.select().from(diamondOrders)
      .where(and(eq(diamondOrders.id, String(req.params.id)), eq(diamondOrders.clubId, access.club.id)));
    if (!order) throw new AppError('commerce.order_not_found', 404);
    return {
      order: {
        id: order.id, status: order.status, diamonds: order.diamonds, netCents: order.netCents, totalCents: order.totalCents,
        discountPct: order.discountPct, isTest: order.isTest, provider: order.provider, createdAt: order.createdAt, paidAt: order.paidAt,
      },
    };
  }));

  r.post('/orders/:id/simulate', handle(async (req) => simulatePayment(ctx, await requireOwner(ctx, req), String(req.params.id))));

  r.get('/orders/:id/receipt.pdf', handle(async (req, res) => {
    const access = await requireOwner(ctx, req);
    const [order] = await ctx.db.select().from(diamondOrders)
      .where(and(eq(diamondOrders.id, String(req.params.id)), eq(diamondOrders.clubId, access.club.id)));
    if (!order) throw new AppError('commerce.order_not_found', 404);
    if (!order.receiptRef) throw new AppError('commerce.document_not_found', 404);
    const pdf = await receipts().document(order.receiptRef).catch(() => null);
    if (!pdf) throw new AppError('commerce.document_unavailable', 502);
    res.type('application/pdf').send(pdf);
  }));

  r.get('/refunds/:id/credit.pdf', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    const [refund] = await ctx.db.select().from(diamondRefunds)
      .where(and(eq(diamondRefunds.id, String(req.params.id)), eq(diamondRefunds.clubId, access.club.id)));
    if (!refund) throw new AppError('commerce.order_not_found', 404);
    // The no-op receipts provider never issues credit notes.
    throw new AppError('commerce.document_not_found', 404);
  }));

  r.get('/level/quote', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    const { productId } = productBody.parse(req.query);
    return { quote: await quoteLevel(ctx.db, access.club.id, productId, ctx.now()) };
  }));

  r.post('/level/upgrade', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    const { productId } = productBody.parse(req.body);
    const key = idempotencyKey(req);
    return ctx.db.transaction((tx) => once(tx, `level_upgrade:${access.club.id}`, key, ctx.now(), () => upgradeLevel(ctx, tx, access, productId)));
  }));

  r.post('/level/downgrade', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    const { productId } = productBody.parse(req.body);
    return ctx.db.transaction((tx) => scheduleDowngrade(ctx, tx, access, productId));
  }));

  r.delete('/level/downgrade', handle(async (req) => {
    const access = await requireOwner(ctx, req);
    return ctx.db.transaction((tx) => cancelDowngrade(ctx, tx, access));
  }));

  return r;
}
