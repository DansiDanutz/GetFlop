import { z } from 'zod';
import { AppError } from '../../http/errors.js';
import { dateRange, DEFAULT_TZ, tzSchema, type Range } from '../inspector/time.js';

export const periodQuery = z.object({
  dateStart: z.string().max(10).optional(),
  dateEnd: z.string().max(10).optional(),
  tz: tzSchema,
});
export type PeriodQuery = z.infer<typeof periodQuery>;

/** Both dates → that range of club days; neither → all time (undefined). */
export function parsePeriod(q: PeriodQuery): Range | undefined {
  if (!q.dateStart && !q.dateEnd) return undefined;
  if (!q.dateStart || !q.dateEnd) throw new AppError('report.range_invalid');
  return dateRange(q.dateStart, q.dateEnd, q.tz ?? DEFAULT_TZ);
}
