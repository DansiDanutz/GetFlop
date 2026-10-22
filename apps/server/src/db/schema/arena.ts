// Tables for the Arena module (public auto-dealt table played with Stars).
// Star amounts use the same integer scale as Points: 100 = 1 ★. Euro amounts are integer euro cents.
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './core.js';

const id = () => text('id').primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const stars = (name: string) => bigint(name, { mode: 'number' });

/** One row per person who entered the Arena: membership, board visibility and badge progress. */
export const arenaPlayers = pgTable('arena_players', {
  userId: text('user_id').primaryKey().references(() => users.id),
  joinedAt: ts('joined_at').notNull(),
  boardHidden: boolean('board_hidden').notNull().default(false),
  lastRefillAt: ts('last_refill_at'),
  /** Presence: the table is awake while someone was seen recently. */
  lastSeenAt: ts('last_seen_at'),
  lastTableId: text('last_table_id'),
  totalFlops: integer('total_flops').notNull().default(0),
  flopsWon: integer('flops_won').notNull().default(0),
  winStreak: integer('win_streak').notNull().default(0),
  bestWinStreak: integer('best_win_streak').notNull().default(0),
  /** Platform-local day key (YYYY-MM-DD) of the last flop played. */
  lastPlayDay: text('last_play_day'),
  dayStreak: integer('day_streak').notNull().default(0),
  bestDayStreak: integer('best_day_streak').notNull().default(0),
  marketsPlayed: text('markets_played').array().notNull().default(sql`'{}'::text[]`),
  marketsWon: text('markets_won').array().notNull().default(sql`'{}'::text[]`),
  /** Best winning multiplier ×100. */
  bestHitX100: integer('best_hit_x100').notNull().default(0),
  /** Week key in which the balance fell under the comeback floor. */
  lowWeek: text('low_week'),
}, (t) => [index('arena_players_seen_idx').on(t.lastSeenAt)]);

/** wallet (per player) | riding (live coupons) | house (the Arena's side of every pick). */
export type StarAccountKind = 'wallet' | 'riding' | 'house';

export const starAccounts = pgTable('star_accounts', {
  id: id(),
  kind: text('kind').$type<StarAccountKind>().notNull(),
  userId: text('user_id').references(() => users.id),
  balanceCents: stars('balance_cents').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('star_accounts_uq').on(t.kind, sql`coalesce(${t.userId}, '')`)]);

/** Append-only Star ledger. `from` null = Stars issued (welcome, refill, purchase). */
export const starLedger = pgTable('star_ledger', {
  id: id(),
  /** welcome, refill, purchase, coupon_placed, bet_settled, bet_won, coupon_refund … */
  kind: text('kind').notNull(),
  fromAccountId: text('from_account_id').references(() => starAccounts.id),
  toAccountId: text('to_account_id').references(() => starAccounts.id),
  amountCents: stars('amount_cents').notNull(),
  fromBalanceAfter: stars('from_balance_after'),
  toBalanceAfter: stars('to_balance_after'),
  userId: text('user_id').references(() => users.id),
  refType: text('ref_type'),
  refId: text('ref_id'),
  createdAt: createdAt(),
}, (t) => [index('star_ledger_kind_created_idx').on(t.kind, t.createdAt), index('star_ledger_user_idx').on(t.userId)]);

/**
 * Board aggregates per player and period. period: 'w:<monday>' | 'm:<YYYY-MM>' | 'all'.
 * They survive hand retention, so the all-time board never shrinks.
 */
export const arenaStats = pgTable('arena_stats', {
  userId: text('user_id').notNull().references(() => users.id),
  period: text('period').notNull(),
  flops: integer('flops').notNull().default(0),
  flopsWon: integer('flops_won').notNull().default(0),
  picks: integer('picks').notNull().default(0),
  picksWon: integer('picks_won').notNull().default(0),
  wageredCents: stars('wagered_cents').notNull().default(0),
  paidCents: stars('paid_cents').notNull().default(0),
  netCents: stars('net_cents').notNull().default(0),
  biggestHitCents: stars('biggest_hit_cents').notNull().default(0),
  biggestHitX100: integer('biggest_hit_x100').notNull().default(0),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.period] }), index('arena_stats_period_idx').on(t.period, t.netCents)]);

export const arenaBadges = pgTable('arena_badges', {
  userId: text('user_id').notNull().references(() => users.id),
  code: text('code').notNull(),
  earnedAt: ts('earned_at').notNull(),
  /** Weekly badges can be earned again. */
  times: integer('times').notNull().default(1),
}, (t) => [primaryKey({ columns: [t.userId, t.code] })]);

export type StarOrderStatus = 'open' | 'paid' | 'cancelled' | 'expired';

export const starOrders = pgTable('star_orders', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id),
  packId: text('pack_id').notNull(),
  starsCents: stars('stars_cents').notNull(),
  /** Euro cents, net of VAT. */
  priceCents: integer('price_cents').notNull(),
  vatCents: integer('vat_cents').notNull(),
  totalCents: integer('total_cents').notNull(),
  status: text('status').$type<StarOrderStatus>().notNull().default('open'),
  provider: text('provider').notNull(),
  providerRef: text('provider_ref'),
  locale: text('locale'),
  createdAt: createdAt(),
  paidAt: ts('paid_at'),
  cancelledAt: ts('cancelled_at'),
}, (t) => [index('star_orders_user_idx').on(t.userId, t.createdAt), index('star_orders_status_idx').on(t.status)]);

/** Small key/value state: last closed week, all-time flop counter, last champion. */
export const arenaState = pgTable('arena_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const arenaWeekAwards = pgTable('arena_week_awards', {
  week: text('week').notNull(),
  userId: text('user_id').notNull().references(() => users.id),
  rank: integer('rank').notNull(),
  netCents: stars('net_cents').notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.week, t.userId] })]);
