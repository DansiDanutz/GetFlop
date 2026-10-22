import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rateLimit.js';

describe('createRateLimiter', () => {
  const t0 = new Date('2026-09-24T18:00:00Z').getTime();

  it('allows attempts until the limit is reached within the window', () => {
    // Arrange
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000 });
    // Act
    [0, 1, 2].forEach((i) => limiter.hit('ip', t0 + i));
    // Assert
    expect(limiter.isLimited('ip', t0 + 10)).toBe(true);
    expect(limiter.isLimited('other', t0 + 10)).toBe(false);
  });

  it('forgets attempts older than the window', () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000 });
    limiter.hit('ip', t0);
    limiter.hit('ip', t0 + 1);
    expect(limiter.isLimited('ip', t0 + 59_000)).toBe(true);
    expect(limiter.isLimited('ip', t0 + 60_002)).toBe(false);
  });

  it('reset clears one key only', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
    limiter.hit('a', t0);
    limiter.hit('b', t0);
    limiter.reset('a');
    expect(limiter.isLimited('a', t0)).toBe(false);
    expect(limiter.isLimited('b', t0)).toBe(true);
  });

  it('sweeps stale keys once too many addresses are tracked', () => {
    const limiter = createRateLimiter({ max: 5, windowMs: 1_000, sweepAbove: 3 });
    ['a', 'b', 'c'].forEach((k) => limiter.hit(k, t0));
    expect(limiter.size()).toBe(3);
    limiter.hit('d', t0 + 5_000);
    expect(limiter.size()).toBe(1);
  });
});
