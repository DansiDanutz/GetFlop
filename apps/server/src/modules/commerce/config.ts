/**
 * Commerce configuration, read from the environment at call time (tests stub env vars).
 *
 * Chosen defaults (the spec leaves these open, see 12 §5 and 00 §6):
 * - COMMERCE_PILOT=1 (default ON): every club is in the free pilot; charges are measured as previews and nothing pauses.
 * - Unpaid play charges: grace of 3 days after the first unpaid hand, or until 5,000 D are pending.
 * - Renewal that cannot be paid: 3 days to add the shortfall, then the club is paused (restricted).
 * - "low" state below 7 days of runway, "critical" below 2 days.
 * - Refund window 14 days. Diamonds valid 12 months (365 days).
 */
export const DAY_MS = 86_400_000;
export const LEVEL_PERIOD_DAYS = 30;
export const LOT_VALIDITY_DAYS = 365;
export const REFUND_WINDOW_DAYS = 14;
export const LOW_RUNWAY_DAYS = 7;
export const CRITICAL_RUNWAY_DAYS = 2;
export const BILLING_START_MIN_HOURS = 72;
/** Stripe signature timestamp tolerance. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
};

const intEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

export interface CommerceConfig {
  /** Global pilot: nothing is charged, nothing pauses. */
  readonly pilot: boolean;
  readonly stripeSecretKey: string | undefined;
  readonly stripeWebhookSecret: string | undefined;
  /** Stripe Tax (automatic VAT) at checkout. */
  readonly stripeTax: boolean;
  /** DEV-only simulated card payments (never in production). */
  readonly devPayments: boolean;
  readonly usageGraceDays: number;
  readonly usageMaxPendingD: number;
  readonly renewalGraceDays: number;
  readonly isTestMode: boolean;
}

export function commerceConfig(): CommerceConfig {
  const stripeSecretKey = env('STRIPE_SECRET_KEY');
  return {
    pilot: env('COMMERCE_PILOT') !== '0',
    stripeSecretKey,
    stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET'),
    stripeTax: env('STRIPE_TAX') === '1',
    devPayments: process.env.NODE_ENV !== 'production' && env('COMMERCE_DEV_PAYMENTS') === '1',
    usageGraceDays: intEnv('COMMERCE_USAGE_GRACE_DAYS', 3),
    usageMaxPendingD: intEnv('COMMERCE_USAGE_MAX_PENDING_D', 5_000),
    renewalGraceDays: intEnv('COMMERCE_RENEWAL_GRACE_DAYS', 3),
    isTestMode: !stripeSecretKey || stripeSecretKey.startsWith('sk_test_'),
  };
}

export const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * DAY_MS);
