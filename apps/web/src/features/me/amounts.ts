import { parsePoints } from '../../lib/format';

/** request = ask the club for Points (reload); return = give Points back (cashout). */
export type PointsMode = 'request' | 'return';

export interface PointRequest {
  id: string;
  kind: 'load' | 'cashout';
  amountCents: number;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedAt?: string | null;
  rejectionReason?: string | null;
}

export interface RequestLists {
  reloads: PointRequest[];
  cashouts: PointRequest[];
}

export type AmountError = 'empty' | 'invalid' | 'over_balance' | 'nothing_to_return';
export type AmountCheck = { ok: true; cents: number } | { ok: false; error: AmountError };

/** Validates what the player typed (digits, `.` or `,`, ≤ 2 decimals, > 0; returns ≤ balance). */
export function checkAmount(text: string, mode: PointsMode, balanceCents: number): AmountCheck {
  if (mode === 'return' && balanceCents <= 0) return { ok: false, error: 'nothing_to_return' };
  if (!text.trim()) return { ok: false, error: 'empty' };
  const cents = parsePoints(text);
  if (cents === null || cents <= 0) return { ok: false, error: 'invalid' };
  if (mode === 'return' && cents > balanceCents) return { ok: false, error: 'over_balance' };
  return { ok: true, cents };
}

const REQUEST_CHIPS: readonly number[] = [1_000, 2_000, 5_000, 10_000];
const CHIP_COUNT = 4;
/** 1, 2, 5 × powers of ten, in cents, from 1 PT up to 1,000,000 PTS. */
const STEPS: readonly number[] = Array.from({ length: 7 }, (_, p) => [1, 2, 5].map((m) => m * 10 ** p * 100)).flat();

/** Quick amounts: fixed for requests; for returns, the largest round steps within the balance. */
export function quickChips(mode: PointsMode, balanceCents: number): number[] {
  if (mode === 'request') return [...REQUEST_CHIPS];
  return STEPS.filter((s) => s <= balanceCents).slice(-CHIP_COUNT);
}

/** The whole balance as typed text ("All"), with the language's decimal separator. */
export function allAmountText(balanceCents: number, lang: 'en' | 'el'): string {
  const whole = Math.floor(balanceCents / 100);
  const rest = balanceCents % 100;
  const decimals = rest === 0 ? '' : String(rest).padStart(2, '0').replace(/0$/, '');
  return decimals ? `${whole}${lang === 'el' ? ',' : '.'}${decimals}` : String(whole);
}

/** Dictionary key for the one-line guidance under the amount. */
export function guidanceKey(mode: PointsMode, balanceCents: number): string {
  if (mode === 'request') return 'me_points_guide_request';
  return balanceCents > 0 ? 'me_points_guide_return' : 'me_points_guide_nothing';
}

/** The waiting request of the chosen side, if any. */
export function pendingFor(lists: RequestLists | undefined, mode: PointsMode): PointRequest | null {
  if (!lists) return null;
  const list = mode === 'request' ? lists.reloads : lists.cashouts;
  return list.find((r) => r.status === 'pending') ?? null;
}
