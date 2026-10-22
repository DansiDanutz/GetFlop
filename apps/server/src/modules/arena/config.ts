/**
 * Arena parameters. The spec leaves these to the server (11 §3–8, 00 §6 open questions);
 * each can be overridden with an environment variable read at call time.
 *
 * Chosen defaults:
 * - Welcome grant 2,000 ★; a free refill back to 2,000 ★ when under 500 ★, at most once per 24 h.
 * - One flop every 30 s: 20 s of open picks, 3 s "no more picks", then the flop; the result stays 7 s.
 * - The table sleeps when nobody was seen for 60 s and no coupon is live on it.
 * - Minimum 10 ★ per pick; no maximum other than the balance; up to 20 flops per coupon.
 * - Weeks close Monday 00:00 platform time (Europe/Athens); caps reset at local midnight.
 * - Star shop caps €30 per day and €100 per month (VAT included); VAT 24 %.
 * - Hands are kept 30 days.
 */
export const STAR = 100;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
};

const intEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

export interface StarPack {
  readonly id: string;
  readonly starsCents: number;
  /** Euro cents, net of VAT. */
  readonly priceCents: number;
  readonly bonusPct?: number;
}

export const STAR_PACKS: readonly StarPack[] = [
  { id: 'stars_5k', starsCents: 5_000 * STAR, priceCents: 199 },
  { id: 'stars_15k', starsCents: 15_000 * STAR, priceCents: 499, bonusPct: 20 },
  { id: 'stars_40k', starsCents: 40_000 * STAR, priceCents: 999, bonusPct: 60 },
];

export interface ArenaConfig {
  readonly open: boolean;
  readonly shopOpen: boolean;
  readonly timeZone: string;
  readonly welcomeCents: number;
  readonly refillUnderCents: number;
  readonly refillTargetCents: number;
  readonly refillEveryMs: number;
  readonly windowMs: number;
  readonly closingMs: number;
  readonly resultMs: number;
  readonly presenceMs: number;
  readonly minPickCents: number;
  readonly maxRounds: number;
  readonly capDayCents: number;
  readonly capMonthCents: number;
  readonly vatPct: number;
  readonly checkoutTtlMs: number;
  readonly retentionDays: number;
  /** Comeback badge: fall under the floor and climb over the peak in one week. */
  readonly comebackFloorCents: number;
  readonly comebackPeakCents: number;
  /** DEV-only simulated card payments (never in production). */
  readonly devPayments: boolean;
}

export function arenaConfig(): ArenaConfig {
  const windowSeconds = intEnv('ARENA_WINDOW_SECONDS', 20);
  return {
    open: env('ARENA_OPEN') !== '0',
    shopOpen: env('ARENA_SHOP_OPEN') !== '0',
    timeZone: env('ARENA_TIME_ZONE') ?? 'Europe/Athens',
    welcomeCents: 2_000 * STAR,
    refillUnderCents: 500 * STAR,
    refillTargetCents: 2_000 * STAR,
    refillEveryMs: 24 * HOUR_MS,
    windowMs: Math.max(5, windowSeconds) * 1000,
    closingMs: intEnv('ARENA_CLOSING_SECONDS', 3) * 1000,
    resultMs: intEnv('ARENA_RESULT_SECONDS', 7) * 1000,
    presenceMs: intEnv('ARENA_PRESENCE_SECONDS', 60) * 1000,
    minPickCents: 10 * STAR,
    maxRounds: 20,
    capDayCents: intEnv('ARENA_CAP_DAY_CENTS', 3_000),
    capMonthCents: intEnv('ARENA_CAP_MONTH_CENTS', 10_000),
    vatPct: intEnv('ARENA_VAT_PCT', 24),
    checkoutTtlMs: 30 * 60_000,
    retentionDays: intEnv('ARENA_RETENTION_DAYS', 30),
    comebackFloorCents: 100 * STAR,
    comebackPeakCents: 5_000 * STAR,
    devPayments: process.env.NODE_ENV !== 'production' && env('COMMERCE_DEV_PAYMENTS') === '1',
  };
}

/** Seconds of one full deal cycle, shown as "every n″". */
export const dealSeconds = (c: ArenaConfig): number => Math.round((c.windowMs + c.closingMs + c.resultMs) / 1000);

/** No maximum per pick other than the balance: a limit no wallet can reach. */
export const UNLIMITED_CENTS = 1_000_000_000_000;
