/** Pure helpers for the owner/manager screens. Amounts are integer cents of a Point. */

const POINT = 100;
const SEND_STEPS = [1, 2, 5, 10, 20, 50, 100].map((p) => p * POINT);
const CLAIM_CHIP_COUNT = 4;
/** 1, 2, 5 × powers of ten, 1 PT up to 1,000,000 PTS. */
const STEPS: readonly number[] = Array.from({ length: 7 }, (_, p) => [1, 2, 5].map((m) => m * 10 ** p * POINT)).flat();

export const sendChips = (): number[] => [...SEND_STEPS];

/** The largest round steps strictly below the balance (the "Whole balance" chip covers the rest). */
export function claimChips(balanceCents: number): number[] {
  return STEPS.filter((s) => s < balanceCents).slice(-CLAIM_CHIP_COUNT);
}

export type CardPeriod = 'all' | 'today' | '7d' | '30d';
export const CARD_PERIODS: readonly CardPeriod[] = ['all', 'today', '7d', '30d'];
const PERIOD_DAYS: Record<Exclude<CardPeriod, 'all'>, number> = { today: 1, '7d': 7, '30d': 30 };

const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Local inclusive days for the member card figures; null = all time. */
export function periodRange(period: CardPeriod, now = new Date()): { dateStart: string; dateEnd: string } | null {
  if (period === 'all') return null;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (PERIOD_DAYS[period] - 1));
  return { dateStart: localDay(start), dateEnd: localDay(now) };
}

export const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export interface SetupStep { key: string; done: boolean; optional: boolean }

/** "Next step · n of total": the `skip`-th undone required step, cycling. */
export function setupNext(steps: readonly SetupStep[], skip: number): { step: SetupStep; index: number; total: number } | null {
  const required = steps.filter((s) => !s.optional);
  const undone = required.filter((s) => !s.done);
  if (undone.length === 0) return null;
  const step = undone[((skip % undone.length) + undone.length) % undone.length]!;
  return { step, index: required.indexOf(step) + 1, total: required.length };
}
