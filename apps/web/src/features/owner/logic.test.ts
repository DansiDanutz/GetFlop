import { describe, expect, it } from 'vitest';
import { claimChips, periodRange, sendChips, setupNext } from './logic';
import { classifyScan } from './scanParse';
import { cropRect, pickEncoding } from './crop';

describe('Send Out / Claim Back chips', () => {
  it('offers fixed round amounts to send', () => {
    expect(sendChips()).toEqual([100, 200, 500, 1_000, 2_000, 5_000, 10_000]);
  });
  it('offers round steps within the balance for claim back', () => {
    expect(claimChips(0)).toEqual([]);
    expect(claimChips(350)).toEqual([100, 200]);
    expect(claimChips(12_345)).toEqual([1_000, 2_000, 5_000, 10_000]);
    expect(claimChips(10_000)).toEqual([500, 1_000, 2_000, 5_000]);
  });
});

describe('member card periods', () => {
  const now = new Date(2026, 8, 24, 20, 30);
  it('turns a period into local inclusive days', () => {
    expect(periodRange('all', now)).toBeNull();
    expect(periodRange('today', now)).toEqual({ dateStart: '2026-09-24', dateEnd: '2026-09-24' });
    expect(periodRange('7d', now)).toEqual({ dateStart: '2026-09-18', dateEnd: '2026-09-24' });
    expect(periodRange('30d', now)).toEqual({ dateStart: '2026-08-26', dateEnd: '2026-09-24' });
  });
});

describe('setup next step', () => {
  const steps = [
    { key: 'photo', done: true, optional: false }, { key: 'table', done: false, optional: false },
    { key: 'dealer', done: false, optional: false }, { key: 'level', done: false, optional: true },
  ];
  it('cycles through the undone required steps', () => {
    expect(setupNext(steps, 0)).toMatchObject({ step: { key: 'table' }, index: 2, total: 3 });
    expect(setupNext(steps, 1)).toMatchObject({ step: { key: 'dealer' }, index: 3 });
    expect(setupNext(steps, 2)).toMatchObject({ step: { key: 'table' } });
    expect(setupNext(steps.map((s) => ({ ...s, done: true })), 0)).toBeNull();
  });
});

describe('classifyScan', () => {
  const code = '3f1c2b9e-1111-4222-8333-444455556666.1790272800.abcdefghijklmnopqrstuv';
  const origin = 'https://app.getflop.test';
  it('recognises player codes, bare or as links', () => {
    expect(classifyScan(code, origin)).toEqual({ kind: 'player', code });
    expect(classifyScan(`${origin}/#/pc/${code}`, origin)).toEqual({ kind: 'player', code });
  });
  it('recognises table and invite links', () => {
    expect(classifyScan(`${origin}/#/join/AB12CD`, origin)).toEqual({ kind: 'table', joinCode: 'AB12CD' });
    expect(classifyScan(`${origin}/c/1234567`, origin)).toEqual({ kind: 'invite', publicId: '1234567' });
    expect(classifyScan(`${origin}/#/c/1234567`, origin)).toEqual({ kind: 'invite', publicId: '1234567' });
  });
  it('flags old codes, foreign links and unused links', () => {
    expect(classifyScan(`${origin}/#/inspector/player/3f1c2b9e-1111-4222-8333-444455556666`, origin)).toEqual({ kind: 'old' });
    expect(classifyScan('https://example.com/promo', origin)).toEqual({ kind: 'foreign' });
    expect(classifyScan('hello there', origin)).toEqual({ kind: 'foreign' });
    expect(classifyScan(`${origin}/#/player`, origin)).toEqual({ kind: 'unused' });
    expect(classifyScan('   ', origin)).toEqual({ kind: 'empty' });
  });
});

describe('photo crop', () => {
  it('maps the square view to a source rectangle, clamped inside the image', () => {
    expect(cropRect({ width: 800, height: 400 }, { zoom: 1, x: 0, y: 0 })).toEqual({ sx: 200, sy: 0, size: 400 });
    expect(cropRect({ width: 800, height: 400 }, { zoom: 2, x: 0, y: 0 })).toEqual({ sx: 300, sy: 100, size: 200 });
    expect(cropRect({ width: 800, height: 400 }, { zoom: 2, x: 1, y: -1 })).toEqual({ sx: 600, sy: 0, size: 200 });
    expect(cropRect({ width: 300, height: 900 }, { zoom: 4, x: 0, y: 0.5 })).toEqual({ sx: 113, sy: 619, size: 75 });
  });
  it('lowers quality then size until the file fits', () => {
    const sizes: [number, number][] = [];
    const encode = (scale: number, quality: number) => {
      sizes.push([scale, quality]);
      return 'x'.repeat(Math.round(1_000 * scale * quality));
    };
    expect(pickEncoding(encode, 700)?.length).toBeLessThanOrEqual(700);
    expect(sizes[0]).toEqual([1, 0.82]);
    expect(sizes[1]).toEqual([1, 0.72]);
    expect(pickEncoding(() => 'x'.repeat(5_000), 100)).toBeNull();
  });
});
