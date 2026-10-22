import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../http/errors.js';
import { WEBHOOK_TOLERANCE_SECONDS } from './config.js';

/**
 * Minimal Stripe REST client (no SDK): Checkout Sessions and Refunds over fetch,
 * plus webhook signature verification (HMAC SHA-256, scheme v1).
 */
const STRIPE_API = 'https://api.stripe.com/v1';

export interface CheckoutSessionInput {
  readonly orderId: string;
  readonly clubId: string;
  readonly productName: string;
  /** Net unit amount in euro cents (after any promo discount); VAT is added by Stripe Tax. */
  readonly amountCents: number;
  readonly locale: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly automaticTax: boolean;
  readonly customerEmail?: string | null;
}

export interface StripeSession {
  readonly id: string;
  readonly url: string;
}

/** Flattens nested params into Stripe's form encoding (a[b][0]=c). */
export function formEncode(params: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(params).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) return [];
    if (typeof v === 'object') return formEncode(v as Record<string, unknown>, key);
    return [`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`];
  });
}

async function stripePost<T>(secretKey: string, path: string, params: Record<string, unknown>, idempotencyKey: string): Promise<T> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKey,
    },
    body: formEncode(params).join('&'),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok || !json) {
    throw new Error(`Stripe ${path} failed with ${res.status}: ${json?.error?.message ?? 'no body'}`);
  }
  return json;
}

const STRIPE_LOCALES = new Set(['en', 'el']);

export async function createCheckoutSession(secretKey: string, input: CheckoutSessionInput): Promise<StripeSession> {
  const session = await stripePost<{ id: string; url: string }>(secretKey, '/checkout/sessions', {
    mode: 'payment',
    client_reference_id: input.orderId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    locale: STRIPE_LOCALES.has(input.locale) ? input.locale : 'auto',
    customer_email: input.customerEmail ?? undefined,
    metadata: { orderId: input.orderId, clubId: input.clubId, kind: 'diamonds' },
    payment_intent_data: { metadata: { orderId: input.orderId, clubId: input.clubId } },
    automatic_tax: input.automaticTax ? { enabled: 'true' } : undefined,
    billing_address_collection: input.automaticTax ? 'required' : undefined,
    line_items: {
      0: {
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: input.amountCents,
          tax_behavior: input.automaticTax ? 'exclusive' : undefined,
          product_data: { name: input.productName },
        },
      },
    },
  }, `checkout-${input.orderId}`);
  if (!session.id || !session.url) throw new Error('Stripe returned a session without id or url');
  return { id: session.id, url: session.url };
}

export async function createRefund(secretKey: string, paymentIntentId: string, orderId: string): Promise<{ id: string; status: string }> {
  const refund = await stripePost<{ id: string; status: string }>(secretKey, '/refunds', {
    payment_intent: paymentIntentId,
    metadata: { orderId },
  }, `refund-${orderId}`);
  return { id: refund.id, status: refund.status };
}

/** Builds a Stripe-Signature header value (used by tests and local tooling). */
export function signPayload(payload: string, secret: string, timestampSec: number): string {
  const signature = createHmac('sha256', secret).update(`${timestampSec}.${payload}`).digest('hex');
  return `t=${timestampSec},v1=${signature}`;
}

/**
 * Verifies a webhook per Stripe's scheme: HMAC-SHA256 of "<t>.<raw body>" with the endpoint secret,
 * compared in constant time against every v1 signature, and the timestamp within the tolerance.
 */
export function verifySignature(rawBody: string, header: string | undefined, secret: string, nowSec: number): void {
  if (!header) throw new AppError('commerce.webhook_signature_invalid', 400);
  const parts = header.split(',').map((p) => p.trim().split('=') as [string, string]);
  const timestamp = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isInteger(timestamp) || signatures.length === 0) throw new AppError('commerce.webhook_signature_invalid', 400);
  if (Math.abs(nowSec - timestamp) > WEBHOOK_TOLERANCE_SECONDS) throw new AppError('commerce.webhook_signature_invalid', 400);
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'), 'utf8');
  const matches = signatures.some((sig) => {
    const given = Buffer.from(sig, 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) throw new AppError('commerce.webhook_signature_invalid', 400);
}
