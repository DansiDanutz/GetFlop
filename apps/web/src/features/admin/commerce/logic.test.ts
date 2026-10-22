import { describe, expect, it } from 'vitest';
import { productStates, versionPrice } from './logic';
import type { Product, Version } from './types';

const v = (over: Partial<Version>): Version => ({
  id: 'v', productId: 'p', version: 1, status: 'published', priceDiamonds: null, priceCents: null, diamonds: null, bonusPct: null,
  mostPopular: false, rateBp: null, limits: null, effectiveFrom: null, note: null, publishedAt: null, ...over,
});

describe('commerce catalogue display', () => {
  it('prices each kind of product', () => {
    expect(versionPrice('club_level', v({ priceDiamonds: 5_000 }))).toEqual({ key: 'admin_price_level', params: { d: 5_000 } });
    expect(versionPrice('diamond_pack', v({ diamonds: 1_000, priceCents: 1_000 }))).toEqual({ key: 'admin_price_pack', params: { d: 1_000, eur: '10.00' } });
    expect(versionPrice('turnover_rate', v({ rateBp: 100 }))).toEqual({ key: 'admin_price_rate', params: { pct: 1 } });
    expect(versionPrice('point_rate', v({ priceDiamonds: 2 }))).toEqual({ key: 'admin_price_other', params: { d: 2 } });
    expect(versionPrice('diamond_pack', v({}))).toBeNull();
  });

  it('finds the version in force, the scheduled ones and the draft', () => {
    const product = {
      inForceVersionId: 'a', scheduled: ['b'],
      versions: [v({ id: 'a', version: 1 }), v({ id: 'b', version: 2, effectiveFrom: '2026-12-01T00:00:00Z' }), v({ id: 'c', version: 3, status: 'draft' })],
    } as unknown as Product;
    const states = productStates(product);
    expect(states.inForce?.version).toBe(1);
    expect(states.scheduled.map((x) => x.version)).toEqual([2]);
    expect(states.draft?.version).toBe(3);
  });
});
