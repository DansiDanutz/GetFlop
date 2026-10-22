import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { AppError } from '../../http/errors.js';
import { handle } from '../../http/respond.js';
import { hooks, type CouponGuard, type StartGuard } from '../game/hooks.js';
import type { ModuleRegistrar } from '../index.js';
import { addJob } from '../jobs.js';
import { isPaused } from './billing.js';
import { commerceConfig } from './config.js';
import { BILLING_JOB_MS, runBilling } from './job.js';
import { handleStripeEvent, type StripeEvent } from './orders.js';
import { chargeSettledHand } from './playCharge.js';
import { adminCommerceRouter } from './routesAdmin.js';
import { clubCommerceRouter } from './routesClub.js';
import { verifySignature } from './stripe.js';

/** Only club tables are billed; the Arena is outside every club. */
const billedKinds = new Set(['cash', 'tournament']);

// Play charge after every settled Ring Game hand (inside the settlement transaction).
if (!hooks.settled.includes(chargeSettledHand)) hooks.settled.push(chargeSettledHand);

// A club paused by billing starts no new hand; hands already running continue.
const pausedStartGuard: StartGuard = async (ctx, tx, table) => {
  if (!billedKinds.has(table.kind)) return;
  if (await isPaused(tx, table.clubId, ctx.now())) throw new AppError('commerce.paused_staff', 409);
};
if (!hooks.startGuards.includes(pausedStartGuard)) hooks.startGuards.push(pausedStartGuard);

// Players cannot buy new coupons while the club is paused.
const pausedCouponGuard: CouponGuard = async (ctx, tx, { table }) => {
  if (!billedKinds.has(table.kind)) return;
  if (await isPaused(tx, table.clubId, ctx.now())) throw new AppError('commerce.game_unavailable', 409);
};
if (!hooks.couponGuards.includes(pausedCouponGuard)) hooks.couponGuards.push(pausedCouponGuard);

addJob({ name: 'commerce-billing', everyMs: BILLING_JOB_MS, run: runBilling });

function webhookRouter(ctx: AppContext): Router {
  const r = Router();
  r.post('/', handle(async (req) => {
    const secret = commerceConfig().stripeWebhookSecret;
    if (!secret) throw new AppError('commerce.payments_unavailable', 503);
    if (!Buffer.isBuffer(req.body)) throw new AppError('commerce.webhook_signature_invalid', 400);
    const raw = req.body.toString('utf8');
    verifySignature(raw, req.header('stripe-signature'), secret, Math.floor(ctx.now().getTime() / 1000));
    let event: StripeEvent;
    try {
      event = JSON.parse(raw) as StripeEvent;
    } catch {
      throw new AppError('validation.bad_json', 400);
    }
    if (!event?.id || !event.type || !event.data?.object) throw new AppError('validation.invalid', 400);
    return handleStripeEvent(ctx, event);
  }));
  return r;
}

/**
 * Commerce module: Diamonds, Club Levels, play charge, card payments, promo codes, catalogue.
 *   /commerce/club/*          owner Club account
 *   /commerce/admin/*         platform admin
 *   /commerce/stripe/webhook  Stripe (raw body, signature verified)
 */
export const registerCommerce: ModuleRegistrar = (api, ctx) => {
  api.use('/commerce/stripe/webhook', webhookRouter(ctx));
  api.use('/commerce/club', clubCommerceRouter(ctx));
  api.use('/commerce/admin', adminCommerceRouter(ctx));
};
