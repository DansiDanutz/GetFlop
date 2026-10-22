import { commitmentCents, topWinCents } from '@getflop/engine';
import { amount } from '../../lib/format';

/** 100 = 1 ★ (same integer scale as Points). */
export const STAR = 100;

export interface Line {
  readonly key: string;
  readonly params?: Record<string, string | number>;
}

export interface SlipPick {
  readonly market: string;
  readonly multiplier: number;
}

export interface SlipTotals {
  readonly perFlopCents: number;
  readonly commitmentCents: number;
  readonly topWinCents: number;
}

/** One shared amount per pick, per flop. */
export function slipTotals(picks: readonly SlipPick[], stakeCents: number, rounds: number): SlipTotals {
  const selections = picks.map((p) => ({ market: p.market, stakeCents }));
  return {
    perFlopCents: stakeCents * picks.length,
    commitmentCents: commitmentCents({ selections, rounds }),
    topWinCents: topWinCents(picks.map((p) => ({ market: p.market, stakeCents, multiplier: p.multiplier })), rounds),
  };
}

export interface SlipCheck {
  readonly pickCount: number;
  readonly stakeCents: number;
  readonly rounds: number;
  readonly minCents: number;
  readonly maxRounds: number;
  readonly balanceCents: number;
}

/** The first thing stopping the slip, in the order the player should fix it. The Arena has no maximum per pick. */
export function slipProblem(s: SlipCheck): Line | null {
  if (s.pickCount === 0) return { key: 'arena_slip_pick_first' };
  if (!Number.isInteger(s.stakeCents) || s.stakeCents < s.minCents) return { key: 'arena_slip_min', params: { min: s.minCents } };
  if (s.rounds < 1 || s.rounds > s.maxRounds) return { key: 'arena_slip_rounds', params: { max: s.maxRounds } };
  if (s.stakeCents * s.pickCount * s.rounds > s.balanceCents) return { key: 'arena_slip_balance' };
  return null;
}

/** MAX: the largest whole-Star amount per pick the balance covers (0 when not even the minimum fits). */
export function maxStakePerPick(balanceCents: number, pickCount: number, rounds: number, minCents: number): number {
  const share = Math.floor(balanceCents / Math.max(1, pickCount) / Math.max(1, rounds));
  const whole = Math.floor(share / STAR) * STAR;
  return whole >= minCents ? whole : 0;
}

export interface ClockLike {
  readonly phase: string;
  readonly remainingMs: number;
}

/** Phase end as an absolute time, measured from when the answer arrived (no clock skew). */
export function clockEndsAt(clock: ClockLike, receivedAt: number): string | null {
  if (clock.phase === 'asleep') return null;
  return new Date(receivedAt + clock.remainingMs).toISOString();
}

export function durationText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export interface Refill {
  readonly underCents: number;
  readonly targetCents: number;
  readonly amountCents: number;
  readonly ready: boolean;
  readonly nextAt: string | null;
}

export function refillLine(r: Refill, now: number): Line {
  if (r.ready) return { key: 'arena_refill_ready', params: { amount: r.amountCents } };
  if (r.nextAt) return { key: 'arena_refill_next', params: { amount: r.amountCents, in: durationText(new Date(r.nextAt).getTime() - now) } };
  return { key: 'arena_refill_rule', params: { amount: r.amountCents, under: r.underCents } };
}

export interface CapState {
  readonly capDayCents: number;
  readonly capMonthCents: number;
  readonly leftDayCents: number;
  readonly leftMonthCents: number;
}

export function capLines(c: CapState): Line[] {
  return [
    { key: 'arena_cap_day_left', params: { left: c.leftDayCents, cap: c.capDayCents } },
    { key: 'arena_cap_month_left', params: { left: c.leftMonthCents, cap: c.capMonthCents } },
  ];
}

export function badgeRemaining(p: { current: number; target: number } | null): number {
  return p ? Math.max(0, p.target - p.current) : 0;
}

export interface PaymentReturn {
  readonly orderId: string;
  readonly outcome: 'success' | 'cancel';
  readonly simulate: boolean;
}

/** Reads `?order=…&stars=success|cancel[&simulate=1]` from the return URL. */
export function readReturn(search: string): PaymentReturn | null {
  const q = new URLSearchParams(search);
  const outcome = q.get('stars');
  const orderId = q.get('order');
  if (!orderId || (outcome !== 'success' && outcome !== 'cancel')) return null;
  return { orderId, outcome, simulate: q.get('simulate') === '1' };
}

interface SettledBet { userId: string; betTypeSlug: string; amountCents: number; payoutCents: number }
export interface SettledPayload {
  readonly card1: string; readonly card2: string; readonly card3: string;
  readonly matchingSlugs: string[];
  readonly winners: SettledBet[];
  readonly losers: SettledBet[];
}

export interface PickResult { readonly market: string; readonly stakeCents: number; readonly payoutCents: number }
export interface HandResult {
  readonly flop: string[];
  readonly matching: string[];
  readonly won: PickResult[];
  readonly lost: PickResult[];
  readonly netCents: number;
}

/** My picks on a settled hand, or null when I had none. */
export function handResultFor(p: SettledPayload, userId: string): HandResult | null {
  const mine = (list: SettledBet[]): PickResult[] => list.filter((b) => b.userId === userId)
    .map((b) => ({ market: b.betTypeSlug, stakeCents: b.amountCents, payoutCents: b.payoutCents }));
  const won = mine(p.winners);
  const lost = mine(p.losers);
  if (won.length + lost.length === 0) return null;
  const stake = [...won, ...lost].reduce((s, b) => s + b.stakeCents, 0);
  const paid = won.reduce((s, b) => s + b.payoutCents, 0);
  return { flop: [p.card1, p.card2, p.card3], matching: p.matchingSlugs, won, lost, netCents: paid - stake };
}

const STAR_PARAMS = new Set(['amount', 'under', 'min', 'stars', 'net', 'total', 'balance']);

/** Formats the Star-amount params of a line (cents → "12 ★"); other params pass through. */
export function fmtParams(params: Record<string, string | number> | undefined): Record<string, string | number> {
  if (!params) return {};
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, STAR_PARAMS.has(k) && typeof v === 'number' ? amount(v, 'stars') : v]));
}

/** Only http(s) checkout pages are followed (never javascript: or data: URLs). */
export function isSafeCheckoutUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
