import { describe, expect, it } from 'vitest';
import { autoLayout, layoutLabelKey, nextMode, readMode, resolveLayout, writeMode, type KeyValueStore } from './layout';

const phone = { width: 375, height: 800, coarse: true };
const tablet = { width: 1024, height: 768, coarse: true };
const landscapePhone = { width: 800, height: 390, coarse: true };
const smallDesktop = { width: 800, height: 390, coarse: false };

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

describe('card entry layout', () => {
  it('auto picks compact on narrow or short touch screens', () => {
    expect(autoLayout(phone)).toBe('compact');
    expect(autoLayout(landscapePhone)).toBe('compact');
    expect(autoLayout(tablet)).toBe('full');
    expect(autoLayout(smallDesktop)).toBe('full');
    expect(autoLayout({ width: 640, height: 900, coarse: false })).toBe('compact');
  });

  it('forced modes win over the screen', () => {
    expect(resolveLayout('full', phone)).toBe('full');
    expect(resolveLayout('compact', tablet)).toBe('compact');
    expect(resolveLayout('auto', tablet)).toBe('full');
  });

  it('the toggle cycles auto → the opposite of auto → auto', () => {
    expect(nextMode('auto', phone)).toBe('full');
    expect(nextMode('auto', tablet)).toBe('compact');
    expect(nextMode('full', phone)).toBe('auto');
    expect(nextMode('compact', tablet)).toBe('auto');
  });

  it('labels show the mode and, in auto, what it resolved to', () => {
    expect(layoutLabelKey('auto', phone)).toBe('dealer_layout_auto_compact');
    expect(layoutLabelKey('auto', tablet)).toBe('dealer_layout_auto_full');
    expect(layoutLabelKey('full', phone)).toBe('dealer_layout_full');
  });

  it('is stored per device', () => {
    const store = memoryStore();
    expect(readMode(store)).toBe('auto');
    writeMode('compact', store);
    expect(readMode(store)).toBe('compact');
    store.setItem('getflop_dealer_layout', 'weird');
    expect(readMode(store)).toBe('auto');
    expect(readMode(null)).toBe('auto');
    const broken: KeyValueStore = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readMode(broken)).toBe('auto');
    expect(() => writeMode('full', broken)).not.toThrow();
  });
});
