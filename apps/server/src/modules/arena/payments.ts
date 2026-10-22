import type { AppContext } from '../../context.js';
import { arenaConfig } from './config.js';

export interface StarCheckoutRequest {
  readonly orderId: string;
  readonly packId: string;
  readonly starsCents: number;
  /** Euro cents charged, VAT included. */
  readonly totalCents: number;
  readonly locale: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export interface StarCheckoutSession {
  readonly url: string;
  readonly ref: string;
}

/**
 * Card payment provider for Star packs. A real implementation (Stripe Checkout, with a verified
 * webhook calling `fulfilStarOrder`) is plugged in with `setStarPaymentProvider`.
 */
export interface StarPaymentProvider {
  readonly name: string;
  createCheckout(ctx: AppContext, req: StarCheckoutRequest): Promise<StarCheckoutSession>;
}

/** DEV only: sends the player back to the app, where the order can be simulated as paid. */
export const devStarPayments: StarPaymentProvider = {
  name: 'dev',
  createCheckout: async (_ctx, req) => ({ url: `${req.successUrl}&simulate=1`, ref: `dev_${req.orderId}` }),
};

let installed: StarPaymentProvider | null = null;

/** Installs the live provider (e.g. Stripe). Pass null to remove it. */
export function setStarPaymentProvider(provider: StarPaymentProvider | null): void {
  installed = provider;
}

/** The provider in force: the installed one, else the DEV simulator when enabled, else none (card payments unavailable). */
export function starPaymentProvider(): StarPaymentProvider | null {
  if (installed) return installed;
  return arenaConfig().devPayments ? devStarPayments : null;
}
