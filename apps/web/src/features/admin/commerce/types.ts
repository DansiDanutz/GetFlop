/** The commerce module's admin API (spec 12 §10), served under /commerce/admin. */
export const COMMERCE_BASE = '/commerce/admin';

export type ProductKind = 'club_level' | 'diamond_pack' | 'turnover_rate' | 'point_rate' | 'usage_rate';
export type Lifecycle = 'draft' | 'active' | 'archived';

export interface LevelLimits { members: number; ringGames: number; tournaments: number; rooms: number; broadcasts: number | null }

export interface Version {
  id: string; productId: string; version: number; status: 'draft' | 'published' | 'withdrawn';
  priceDiamonds: number | null; priceCents: number | null; diamonds: number | null; bonusPct: number | null; mostPopular: boolean;
  rateBp: number | null; limits: LevelLimits | null; effectiveFrom: string | null; note: string | null; publishedAt: string | null;
}

export interface Product {
  id: string; code: string; kind: ProductKind; nameEn: string; nameEl: string; lifecycle: Lifecycle;
  versions: Version[]; inForceVersionId: string | null; scheduled: string[];
}

export interface Preview {
  version: number; currentVersion: number | null; from: string; kind: ProductKind;
  price?: { fromD?: number | null; toD?: number | null; fromCents?: number | null; toCents?: number | null };
  rate?: { fromBp: number | null; toBp: number | null };
  noticeOk?: boolean; minNoticeDays?: number;
  clubs?: number; firstRenewalAt?: string | null;
  limitsDiff?: { resource: string; from: number | null; to: number | null }[];
  overLimit?: { clubId: string; name: string; resources: string[] }[];
  notice?: { code: string; params: Record<string, string | number> };
}

export interface Order {
  id: string; clubName: string; buyer: string; diamonds: number; status: string; createdAt: string; paidAt: string | null;
  netCents: number; vatCents: number | null; totalCents: number | null; country: string | null; failureReason: string | null;
  receiptStatus: string | null; isTest: boolean;
  refund: { amountCents: number; diamondsTakenBack: number; diamondsShort: number; ground: string } | null;
}

export interface Payments {
  config: {
    cardPayments: { available: boolean; provider: string | null; testMode: boolean }; vat: boolean; receiptsMode: string;
    refundWindowDays: number; webhookConfigured: boolean; pilotForced: boolean;
  };
  alerts: { id: string; kind: string; data: Record<string, unknown>; readAt: string | null; createdAt: string }[];
  unreadAlerts: number;
  orders: Order[];
  diamondRequests: number;
}

export interface PromoCode {
  id: string; code: string; kind: 'gift' | 'percent'; value: number; packId: string | null; clubId: string | null;
  maxUses: number; expiresAt: string; createdAt: string; status: string;
  redemptions: { used: number; reserved: number; released: number };
}

export interface CommerceAuditPage {
  entries: { id: string; action: string; actor: string | null; entityType: string | null; entityId: string | null; data: Record<string, unknown>; createdAt: string }[];
  total: number;
}

export const REFUND_GROUNDS = ['duplicate', 'not_credited', 'our_fault'] as const;
