import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { handle } from '../../http/respond.js';
import { requireAdmin } from '../auth/session.js';
import {
  createDraft, createProduct, deleteDraft, draftInput, listCatalogue, previewVersion, productInput, publishVersion,
  saveDraft, updateProduct, withdrawVersion,
} from './adminCatalogue.js';
import {
  adminClubDetail, adminClubList, auditList, markAlertsRead, paymentsOverview, postponeBillingStart, returnAllToPilot,
  scheduleBillingStart, setEnforcement,
} from './adminClubs.js';
import { idempotencyKey, once } from './idempotency.js';
import { adminTopup, refundOrder, rejectTopupRequest, retryReceipt } from './orders.js';
import { createPromo, disablePromo, listPromos } from './promo.js';

const AUDIT_PAGE = 50;

/** Platform admin commerce API (/commerce/admin/*). Every route requires a platform admin. */
export function adminCommerceRouter(ctx: AppContext): Router {
  const r = Router();
  const param = (v: unknown): string => String(v);

  r.get('/clubs', handle(async (req) => {
    requireAdmin(req);
    const { q } = z.object({ q: z.string().max(80).optional() }).parse(req.query);
    return adminClubList(ctx.db, q, ctx.now());
  }));

  r.get('/clubs/:id', handle(async (req) => {
    requireAdmin(req);
    return adminClubDetail(ctx.db, param(req.params.id), ctx.now());
  }));

  r.put('/clubs/:id/enforcement', handle(async (req) => {
    const admin = requireAdmin(req);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    return ctx.db.transaction((tx) => setEnforcement(ctx, tx, admin.id, param(req.params.id), enabled));
  }));

  r.post('/clubs/:id/topup', handle(async (req) => {
    const admin = requireAdmin(req);
    const body = z.object({
      diamonds: z.number(), reference: z.string().max(120).default(''), note: z.string().max(500).nullable().optional(),
      requestId: z.string().nullable().optional(),
    }).parse(req.body);
    const clubId = param(req.params.id);
    return ctx.db.transaction((tx) => once(tx, `topup:${clubId}`, idempotencyKey(req), ctx.now(), () => adminTopup(ctx, tx, admin.id, clubId, body)));
  }));

  r.post('/topup-requests/:id/reject', handle(async (req) => {
    const admin = requireAdmin(req);
    return ctx.db.transaction((tx) => rejectTopupRequest(ctx, tx, admin.id, param(req.params.id)));
  }));

  r.post('/billing-start', handle(async (req) => {
    const admin = requireAdmin(req);
    const { day } = z.object({ day: z.string().max(10).default('') }).parse(req.body ?? {});
    return ctx.db.transaction((tx) => scheduleBillingStart(ctx, tx, admin.id, day));
  }));

  r.delete('/billing-start', handle(async (req) => {
    const admin = requireAdmin(req);
    return ctx.db.transaction((tx) => postponeBillingStart(ctx, tx, admin.id));
  }));

  r.post('/billing-start/return-to-pilot', handle(async (req) => {
    const admin = requireAdmin(req);
    return ctx.db.transaction((tx) => returnAllToPilot(ctx, tx, admin.id));
  }));

  r.get('/catalogue', handle(async (req) => {
    requireAdmin(req);
    return { products: await listCatalogue(ctx.db, ctx.now()) };
  }));

  r.post('/products', handle(async (req) => {
    const admin = requireAdmin(req);
    const body = productInput.parse(req.body);
    return { product: await ctx.db.transaction((tx) => createProduct(ctx, tx, admin.id, body)) };
  }));

  r.put('/products/:id', handle(async (req) => {
    const admin = requireAdmin(req);
    const body = z.object({
      lifecycle: z.enum(['draft', 'active', 'archived']).optional(),
      nameEn: z.string().trim().min(1).max(80).optional(), nameEl: z.string().trim().min(1).max(80).optional(),
    }).parse(req.body);
    return { product: await ctx.db.transaction((tx) => updateProduct(ctx, tx, admin.id, param(req.params.id), body)) };
  }));

  r.post('/products/:id/drafts', handle(async (req) => {
    const admin = requireAdmin(req);
    return { version: await ctx.db.transaction((tx) => createDraft(ctx, tx, admin.id, param(req.params.id))) };
  }));

  r.put('/versions/:id', handle(async (req) => {
    const admin = requireAdmin(req);
    const body = draftInput.parse(req.body);
    return { version: await ctx.db.transaction((tx) => saveDraft(ctx, tx, admin.id, param(req.params.id), body)) };
  }));

  r.delete('/versions/:id', handle(async (req) => {
    const admin = requireAdmin(req);
    return ctx.db.transaction((tx) => deleteDraft(ctx, tx, admin.id, param(req.params.id)));
  }));

  r.get('/versions/:id/preview', handle(async (req) => {
    requireAdmin(req);
    return { preview: await previewVersion(ctx.db, param(req.params.id), ctx.now()) };
  }));

  r.post('/versions/:id/publish', handle(async (req) => {
    const admin = requireAdmin(req);
    return { version: await ctx.db.transaction((tx) => publishVersion(ctx, tx, admin.id, param(req.params.id))) };
  }));

  r.post('/versions/:id/withdraw', handle(async (req) => {
    const admin = requireAdmin(req);
    return { version: await ctx.db.transaction((tx) => withdrawVersion(ctx, tx, admin.id, param(req.params.id))) };
  }));

  r.get('/payments', handle(async (req) => {
    requireAdmin(req);
    return paymentsOverview(ctx.db);
  }));

  r.post('/alerts/read', handle(async (req) => {
    requireAdmin(req);
    return markAlertsRead(ctx);
  }));

  r.post('/orders/:id/receipt', handle(async (req) => {
    requireAdmin(req);
    return retryReceipt(ctx, param(req.params.id));
  }));

  r.post('/orders/:id/refund', handle(async (req) => {
    const admin = requireAdmin(req);
    const { ground } = z.object({ ground: z.string().default('') }).parse(req.body ?? {});
    return refundOrder(ctx, admin.id, param(req.params.id), ground);
  }));

  r.get('/promo-codes', handle(async (req) => {
    requireAdmin(req);
    return { codes: await listPromos(ctx.db, ctx.now()) };
  }));

  r.post('/promo-codes', handle(async (req) => {
    const admin = requireAdmin(req);
    const body = z.object({
      code: z.string().max(40).nullable().optional(), kind: z.string(), value: z.number(),
      packId: z.string().nullable().optional(), clubId: z.string().nullable().optional(), days: z.number(), uses: z.number(),
    }).parse(req.body);
    return { code: await ctx.db.transaction((tx) => createPromo(ctx, tx, admin.id, body)) };
  }));

  r.post('/promo-codes/:id/disable', handle(async (req) => {
    const admin = requireAdmin(req);
    return { code: await ctx.db.transaction((tx) => disablePromo(ctx, tx, admin.id, param(req.params.id))) };
  }));

  r.get('/audit', handle(async (req) => {
    requireAdmin(req);
    const { page } = z.object({ page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
    return auditList(ctx.db, AUDIT_PAGE, (page - 1) * AUDIT_PAGE);
  }));

  return r;
}
