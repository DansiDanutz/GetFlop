import { AppError } from '../../http/errors.js';

/** Validates an IANA timezone name; empty means UTC. */
export function parseTz(tz: unknown): string {
  if (tz === undefined || tz === null || tz === '') return 'UTC';
  if (typeof tz !== 'string' || tz.length > 64) throw new AppError('validation.invalid', 400, { field: 'tz' });
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    throw new AppError('validation.invalid', 400, { field: 'tz' });
  }
}

interface Parts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function partsIn(date: Date, tz: string): Parts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const map = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(map.year), month: Number(map.month), day: Number(map.day),
    hour: Number(map.hour), minute: Number(map.minute), second: Number(map.second),
  };
}

/** Milliseconds the zone is ahead of UTC at `date`. */
function offsetMs(date: Date, tz: string): number {
  const p = partsIn(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant of 00:00 on the 1st of the current month in `tz`. */
export function startOfMonth(now: Date, tz: string): Date {
  const p = partsIn(now, tz);
  const localMidnight = Date.UTC(p.year, p.month - 1, 1);
  const first = localMidnight - offsetMs(new Date(localMidnight), tz);
  // Re-check the offset at the result (DST change between the guess and the answer).
  return new Date(localMidnight - offsetMs(new Date(first), tz));
}

/** The instant of 00:00 on the 1st of the next month in `tz`. */
export function startOfNextMonth(now: Date, tz: string): Date {
  const p = partsIn(now, tz);
  const next = new Date(Date.UTC(p.month === 12 ? p.year + 1 : p.year, p.month === 12 ? 0 : p.month, 15));
  return startOfMonth(next, tz);
}
