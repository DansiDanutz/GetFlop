/**
 * A small in-memory sliding-window counter (one per app instance).
 * Time is passed in by the caller so tests can drive it with ctx.now().
 */
export interface RateLimiter {
  hit(key: string, nowMs: number): void;
  isLimited(key: string, nowMs: number): boolean;
  reset(key: string): void;
  /** Number of tracked keys (for tests and diagnostics). */
  size(): number;
}

export interface RateLimitOptions {
  readonly max: number;
  readonly windowMs: number;
  /** Above this many tracked keys, stale keys are swept (bounds memory under many addresses). */
  readonly sweepAbove?: number;
}

const DEFAULT_SWEEP_ABOVE = 10_000;

export function createRateLimiter({ max, windowMs, sweepAbove = DEFAULT_SWEEP_ABOVE }: RateLimitOptions): RateLimiter {
  const hits = new Map<string, readonly number[]>();
  const recent = (key: string, nowMs: number): readonly number[] =>
    (hits.get(key) ?? []).filter((t) => nowMs - t < windowMs);
  const sweep = (nowMs: number): void => {
    for (const key of [...hits.keys()]) if (recent(key, nowMs).length === 0) hits.delete(key);
  };

  return {
    hit(key, nowMs) {
      if (hits.size >= sweepAbove) sweep(nowMs);
      hits.set(key, [...recent(key, nowMs), nowMs]);
    },
    isLimited(key, nowMs) {
      const list = recent(key, nowMs);
      if (list.length === 0) hits.delete(key);
      else hits.set(key, list);
      return list.length >= max;
    },
    reset(key) {
      hits.delete(key);
    },
    size() {
      return hits.size;
    },
  };
}
