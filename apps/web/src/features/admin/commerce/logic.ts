import type { Product, ProductKind, Version } from './types';

export interface Label { readonly key: string; readonly params: Record<string, string | number> }

/** How a version's price reads for its product kind, or null when the draft has no price yet. */
export function versionPrice(kind: ProductKind, v: Version): Label | null {
  if (kind === 'club_level') return v.priceDiamonds === null ? null : { key: 'admin_price_level', params: { d: v.priceDiamonds } };
  if (kind === 'diamond_pack') {
    return v.diamonds === null || v.priceCents === null ? null
      : { key: 'admin_price_pack', params: { d: v.diamonds, eur: (v.priceCents / 100).toFixed(2) } };
  }
  if (kind === 'turnover_rate') return v.rateBp === null ? null : { key: 'admin_price_rate', params: { pct: v.rateBp / 100 } };
  return v.priceDiamonds === null ? null : { key: 'admin_price_other', params: { d: v.priceDiamonds } };
}

export interface ProductStates { inForce: Version | null; scheduled: Version[]; draft: Version | null }

export function productStates(p: Product): ProductStates {
  return {
    inForce: p.versions.find((x) => x.id === p.inForceVersionId) ?? null,
    scheduled: p.versions.filter((x) => p.scheduled.includes(x.id)),
    draft: p.versions.find((x) => x.status === 'draft') ?? null,
  };
}
