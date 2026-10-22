// Tables for the commerce module (Diamonds, Club Levels, play charge, orders, promo codes, catalogue).
// Diamond amounts are whole Diamonds (100 D = €1). Euro amounts are integer euro cents.
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { clubs, users } from './core.js';

const id = () => text('id').primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const num = (name: string) => bigint(name, { mode: 'number' });

export interface LevelLimitsJson {
  members: number;
  ringGames: number;
  tournaments: number;
  rooms: number;
  /** Promotional broadcasts per month; null = not limited. */
  broadcasts: number | null;
}

// ───────────────────────────── Catalogue ─────────────────────────────

/** club_level | diamond_pack | turnover_rate | point_rate (legacy) | usage_rate (legacy) */
export type ProductKind = 'club_level' | 'diamond_pack' | 'turnover_rate' | 'point_rate' | 'usage_rate';
export type ProductLifecycle = 'draft' | 'active' | 'archived';
export type VersionStatus = 'draft' | 'published' | 'withdrawn';

export const commerceProducts = pgTable('commerce_products', {
  id: id(),
  code: text('code').notNull(),
  kind: text('kind').$type<ProductKind>().notNull(),
  nameEn: text('name_en').notNull(),
  nameEl: text('name_el').notNull(),
  lifecycle: text('lifecycle').$type<ProductLifecycle>().notNull().default('draft'),
  /** Order inside its kind (Level rank, pack order). */
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('commerce_products_code_uq').on(t.code)]);

/** A published version never changes; a correction is a new version. */
export const commerceVersions = pgTable('commerce_versions', {
  id: id(),
  productId: text('product_id').notNull().references(() => commerceProducts.id),
  version: integer('version').notNull(),
  status: text('status').$type<VersionStatus>().notNull().default('draft'),
  priceDiamonds: integer('price_diamonds'),
  /** Diamond packs: euro cents, net of VAT. */
  priceCents: integer('price_cents'),
  /** Diamond packs: Diamonds delivered (bonus included separately). */
  diamonds: integer('diamonds'),
  bonusPct: integer('bonus_pct'),
  mostPopular: boolean('most_popular').notNull().default(false),
  /** turnover_rate: percent × 100 (100 = 1% = 1 D per Point). */
  rateBp: integer('rate_bp'),
  limits: jsonb('limits').$type<LevelLimitsJson>(),
  /** Null = in force from publication. */
  effectiveFrom: ts('effective_from'),
  note: text('note'),
  publishedAt: ts('published_at'),
  withdrawnAt: ts('withdrawn_at'),
  createdBy: text('created_by').references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('commerce_versions_product_version_uq').on(t.productId, t.version)]);

// ───────────────────────────── Club billing ─────────────────────────────

/** One row per club: Level period, billing mode, pause bookkeeping, preferences. */
export const clubBilling = pgTable('club_billing', {
  clubId: text('club_id').primaryKey().references(() => clubs.id),
  /** Level product code (mirrors clubs.level). */
  levelCode: text('level_code').notNull().default('starter'),
  /** Version whose price/limits apply to the current period. */
  levelVersionId: text('level_version_id').references(() => commerceVersions.id),
  periodStartAt: ts('period_start_at'),
  /** Null on Starter (nothing to renew). */
  renewsAt: ts('renews_at'),
  pendingDowngradeCode: text('pending_downgrade_code'),
  /** Admin switch: charges are taken (true) or only previewed (false). */
  enforced: boolean('enforced').notNull().default(false),
  /** Renewal that could not be paid: overdue since / pay-by deadline. */
  renewalOverdueSince: ts('renewal_overdue_since'),
  renewalDeadline: ts('renewal_deadline'),
  /** renewsAt value a reminder was already sent for (one reminder per period). */
  reminderSentFor: ts('reminder_sent_for'),
  /** Set when the owner was told the club is paused; cleared on recovery. */
  pausedNotifiedAt: ts('paused_notified_at'),
  noticeShownAt: ts('notice_shown_at'),
  noticeShownKind: text('notice_shown_kind'),
  prefs: jsonb('prefs').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Append-only Diamond ledger. amount is signed; balance_after is the club's balance after the row. */
export const diamondLedger = pgTable('diamond_ledger', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  /** topup, grant, level_charge, usage_charge, usage_refund, charge_settlement, expiry, refund, point_purchase */
  type: text('type').notNull(),
  amount: num('amount').notNull(),
  balanceAfter: num('balance_after').notNull(),
  refType: text('ref_type'),
  refId: text('ref_id'),
  actorId: text('actor_id').references(() => users.id),
  note: text('note'),
  data: jsonb('data').$type<Record<string, unknown>>(),
  createdAt: createdAt(),
}, (t) => [index('diamond_ledger_club_created_idx').on(t.clubId, t.createdAt)]);

/** Diamonds valid 12 months from arrival; spent oldest first. */
export const diamondLots = pgTable('diamond_lots', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  /** topup | grant | card */
  source: text('source').notNull(),
  orderId: text('order_id'),
  originalAmount: num('original_amount').notNull(),
  remaining: num('remaining').notNull(),
  expiresAt: ts('expires_at').notNull(),
  expiredAt: ts('expired_at'),
  createdAt: createdAt(),
}, (t) => [index('diamond_lots_club_idx').on(t.clubId, t.expiresAt)]);

/**
 * Level and play charges. status: preview (pilot, not charged), charged, pending (unpaid), settled (paid later).
 * kind: level, hand, tournament_entry, entry_refund, usage_legacy.
 */
export const commerceCharges = pgTable('commerce_charges', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  diamonds: num('diamonds').notNull(),
  /** Points played (cents of a Point) behind a play charge. */
  pointsCents: num('points_cents').notNull().default(0),
  handId: text('hand_id'),
  tableId: text('table_id'),
  tournamentId: text('tournament_id'),
  userId: text('user_id'),
  label: text('label'),
  data: jsonb('data').$type<Record<string, unknown>>(),
  settledAt: ts('settled_at'),
  createdAt: createdAt(),
}, (t) => [
  index('commerce_charges_club_idx').on(t.clubId, t.createdAt),
  uniqueIndex('commerce_charges_hand_uq').on(t.handId),
]);

// ───────────────────────────── Orders, refunds, requests ─────────────────────────────

export type OrderStatus = 'pending' | 'paid' | 'expired' | 'failed' | 'refunded';

export const diamondOrders = pgTable('diamond_orders', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  buyerId: text('buyer_id').notNull().references(() => users.id),
  packVersionId: text('pack_version_id').notNull().references(() => commerceVersions.id),
  diamonds: integer('diamonds').notNull(),
  listCents: integer('list_cents').notNull(),
  netCents: integer('net_cents').notNull(),
  discountPct: integer('discount_pct'),
  promoCodeId: text('promo_code_id'),
  currency: text('currency').notNull().default('eur'),
  status: text('status').$type<OrderStatus>().notNull().default('pending'),
  /** stripe | dev */
  provider: text('provider').notNull(),
  isTest: boolean('is_test').notNull().default(true),
  stripeSessionId: text('stripe_session_id'),
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  paidSubtotalCents: integer('paid_subtotal_cents'),
  vatCents: integer('vat_cents'),
  totalCents: integer('total_cents'),
  country: text('country'),
  failureReason: text('failure_reason'),
  /** issued, drafted, sending, error, needs_review, skipped, void */
  receiptStatus: text('receipt_status'),
  receiptRef: text('receipt_ref'),
  paidAt: ts('paid_at'),
  refundedAt: ts('refunded_at'),
  createdAt: createdAt(),
}, (t) => [
  index('diamond_orders_club_idx').on(t.clubId, t.createdAt),
  uniqueIndex('diamond_orders_session_uq').on(t.stripeSessionId),
]);

export const diamondRefunds = pgTable('diamond_refunds', {
  id: id(),
  orderId: text('order_id').notNull().references(() => diamondOrders.id),
  clubId: text('club_id').notNull().references(() => clubs.id),
  ground: text('ground').notNull(),
  amountCents: integer('amount_cents').notNull(),
  diamondsTakenBack: integer('diamonds_taken_back').notNull(),
  diamondsShort: integer('diamonds_short').notNull(),
  stripeRefundId: text('stripe_refund_id'),
  creditNoteStatus: text('credit_note_status'),
  actorId: text('actor_id').references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('diamond_refunds_order_uq').on(t.orderId)]);

export const topupRequests = pgTable('commerce_topup_requests', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  packVersionId: text('pack_version_id').notNull().references(() => commerceVersions.id),
  diamonds: integer('diamonds').notNull(),
  /** pending | done | rejected */
  status: text('status').notNull().default('pending'),
  requestedBy: text('requested_by').notNull().references(() => users.id),
  resolvedBy: text('resolved_by').references(() => users.id),
  resolvedAt: ts('resolved_at'),
  createdAt: createdAt(),
}, (t) => [index('commerce_topup_requests_club_idx').on(t.clubId, t.status)]);

/** Stripe events already processed (webhook idempotency). */
export const stripeEvents = pgTable('commerce_stripe_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  processedAt: createdAt(),
});

/** Idempotency-Key replays for money-moving owner/admin actions. */
export const commerceIdempotency = pgTable('commerce_idempotency', {
  scope: text('scope').notNull(),
  key: text('key').notNull(),
  response: jsonb('response').$type<unknown>().notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.scope, t.key] })]);

// ───────────────────────────── Promo codes ─────────────────────────────

export const promoCodes = pgTable('commerce_promo_codes', {
  id: id(),
  code: text('code').notNull(),
  /** gift | percent */
  kind: text('kind').notNull(),
  value: integer('value').notNull(),
  /** Percent codes: restricted to one pack product. */
  packProductId: text('pack_product_id').references(() => commerceProducts.id),
  /** Null = any club. */
  clubId: text('club_id').references(() => clubs.id),
  maxUses: integer('max_uses').notNull(),
  expiresAt: ts('expires_at').notNull(),
  /** active | withdrawn (expired / used up are derived). */
  status: text('status').notNull().default('active'),
  createdBy: text('created_by').references(() => users.id),
  withdrawnAt: ts('withdrawn_at'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('commerce_promo_codes_code_uq').on(sql`upper(${t.code})`)]);

export const promoRedemptions = pgTable('commerce_promo_redemptions', {
  id: id(),
  codeId: text('code_id').notNull().references(() => promoCodes.id),
  clubId: text('club_id').notNull().references(() => clubs.id),
  orderId: text('order_id'),
  /** reserved (at checkout) | used | released */
  state: text('state').notNull(),
  createdAt: createdAt(),
}, (t) => [index('commerce_promo_redemptions_code_idx').on(t.codeId)]);

// ───────────────────────────── Messages, alerts, audit, settings ─────────────────────────────

/** Club account messages (owner notifications). params feed the msg_<code> translation. */
export const accountMessages = pgTable('commerce_account_messages', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  code: text('code').notNull(),
  params: jsonb('params').$type<Record<string, string | number>>().notNull().default({}),
  readAt: ts('read_at'),
  createdAt: createdAt(),
}, (t) => [index('commerce_account_messages_club_idx').on(t.clubId, t.createdAt)]);

/** Platform alerts for the admin Payments tab (payment_mismatch, refund_short, chargeback …). */
export const commerceAlerts = pgTable('commerce_alerts', {
  id: id(),
  kind: text('kind').notNull(),
  clubId: text('club_id'),
  orderId: text('order_id'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  readAt: ts('read_at'),
  createdAt: createdAt(),
});

/** Commerce audit (catalogue, billing switches, codes). Append-only. */
export const commerceAudit = pgTable('commerce_audit', {
  id: id(),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index('commerce_audit_created_idx').on(t.createdAt)]);

/** Platform-wide commerce settings (billing start …). */
export const commerceSettings = pgTable('commerce_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
