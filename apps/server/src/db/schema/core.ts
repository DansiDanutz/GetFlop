import { sql } from 'drizzle-orm';
import {
  bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';

const id = () => text('id').primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
/** Integer cents of a Point (or TC / Stars). bigint in mode number: safe below 2^53. */
const cents = (name: string) => bigint(name, { mode: 'number' });

// ───────────────────────────── Accounts ─────────────────────────────

export const users = pgTable('users', {
  id: id(),
  username: text('username').notNull(),
  displayName: text('display_name'),
  pinHash: text('pin_hash').notNull(),
  email: text('email'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  googleSub: text('google_sub'),
  language: text('language').notNull().default('en'),
  isActive: boolean('is_active').notNull().default(true),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  isBot: boolean('is_bot').notNull().default(false),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  marketingConsent: boolean('marketing_consent'),
  activeClubId: text('active_club_id'),
  /** Personal code shown at the club desk ("My code"). */
  playerCode: text('player_code').notNull().$defaultFn(() => crypto.randomUUID().replace(/-/g, '').slice(0, 12)),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('users_username_uq').on(sql`lower(${t.username})`),
  uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
  uniqueIndex('users_google_uq').on(t.googleSub),
  uniqueIndex('users_player_code_uq').on(t.playerCode),
]);

export const sessions = pgTable('sessions', {
  /** sha256 of the opaque token held in the cookie. */
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  userAgent: text('user_agent'),
}, (t) => [index('sessions_user_idx').on(t.userId)]);

/** One-time codes: email verification, PIN reset, registration codes. */
export const authCodes = pgTable('auth_codes', {
  id: id(),
  userId: text('user_id').references(() => users.id),
  purpose: text('purpose').notNull(),
  target: text('target'),
  codeHash: text('code_hash').notNull(),
  /** Pending data, e.g. the registration form until the code is confirmed. */
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

// ───────────────────────────── Clubs ─────────────────────────────

export const clubs = pgTable('clubs', {
  id: id(),
  /** Public 7-digit Club ID players type to find the club. */
  publicId: text('public_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  photoUrl: text('photo_url'),
  ownerId: text('owner_id').notNull().references(() => users.id),
  /** Club Level code: starter, club100, club500, club1k, club2_5k, club5k. */
  level: text('level').notNull().default('starter'),
  levelRenewsAt: timestamp('level_renews_at', { withTimezone: true }),
  diamondsBalance: cents('diamonds_balance').notNull().default(0),
  inviteToken: text('invite_token').notNull().$defaultFn(() => crypto.randomUUID().replace(/-/g, '').slice(0, 16)),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  dealerSitApproval: boolean('dealer_sit_approval').notNull().default(false),
  /** Free-form club settings (timezone, messaging prefs, live-big threshold, onboarding …). */
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('clubs_public_id_uq').on(t.publicId), uniqueIndex('clubs_invite_uq').on(t.inviteToken)]);

export type Role = 'owner' | 'manager' | 'inspector' | 'dealer';
export type MembershipStatus = 'pending' | 'active' | 'rejected' | 'removed' | 'left';

export const memberships = pgTable('memberships', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  userId: text('user_id').notNull().references(() => users.id),
  roles: text('roles').array().$type<Role[]>().notNull().default(sql`'{}'::text[]`),
  status: text('status').$type<MembershipStatus>().notNull().default('pending'),
  /** play | watch — watch-only members cannot place coupons. */
  playMode: text('play_mode').notNull().default('play'),
  /** How the request arrived: club_id, invite, scan, created. */
  via: text('via').notNull().default('club_id'),
  reviewedBy: text('reviewed_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  lastPlayedAt: timestamp('last_played_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('memberships_club_user_uq').on(t.clubId, t.userId),
  index('memberships_user_idx').on(t.userId),
]);

export const rooms = pgTable('rooms', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

// ───────────────────────────── Points ledger ─────────────────────────────

/** pool = club treasury, player = wallet, stock = inspector stock, riding = live coupon commitments, tournament = prize pool. */
export type AccountKind = 'pool' | 'player' | 'stock' | 'riding' | 'tournament';

/** A Points balance inside a club. Every movement is a ledger entry between two accounts. */
export const pointAccounts = pgTable('point_accounts', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  kind: text('kind').$type<AccountKind>().notNull(),
  /** Player wallet or inspector stock owner; null for pool and game. */
  userId: text('user_id').references(() => users.id),
  refId: text('ref_id'),
  balanceCents: cents('balance_cents').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('point_accounts_uq').on(t.clubId, t.kind, sql`coalesce(${t.userId}, '')`, sql`coalesce(${t.refId}, '')`),
]);

/** Append-only. Never updated or deleted: a correction is a new entry. */
export const ledgerEntries = pgTable('ledger_entries', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  /** mint, send_out, claim_back, stock_out, stock_in, coupon_placed, bet_won, coupon_refund, bet_refunded, tournament_buyin … */
  kind: text('kind').notNull(),
  fromAccountId: text('from_account_id').references(() => pointAccounts.id),
  toAccountId: text('to_account_id').references(() => pointAccounts.id),
  amountCents: cents('amount_cents').notNull(),
  fromBalanceAfter: cents('from_balance_after'),
  toBalanceAfter: cents('to_balance_after'),
  actorId: text('actor_id').references(() => users.id),
  /** The player whose wallet moved, for member-card and report filters. */
  userId: text('user_id').references(() => users.id),
  note: text('note'),
  refType: text('ref_type'),
  refId: text('ref_id'),
  createdAt: createdAt(),
}, (t) => [
  index('ledger_club_created_idx').on(t.clubId, t.createdAt),
  index('ledger_user_idx').on(t.clubId, t.userId),
]);

/** Player requests to load Points or return them to the club; also dealer sit requests. */
export const pointRequests = pgTable('point_requests', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  userId: text('user_id').notNull().references(() => users.id),
  /** load | cashout */
  kind: text('kind').notNull(),
  amountCents: cents('amount_cents').notNull(),
  note: text('note'),
  status: text('status').notNull().default('pending'),
  reviewedBy: text('reviewed_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  createdAt: createdAt(),
}, (t) => [index('point_requests_club_status_idx').on(t.clubId, t.status)]);

// ───────────────────────────── Tables & hands ─────────────────────────────

export interface TableLimitsJson {
  minCents: number;
  maxCents: number;
  couponCapCents: number;
  maxRounds: number;
  marketMaxCents: Record<string, number>;
}

export const clubTables = pgTable('club_tables', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  roomId: text('room_id').references(() => rooms.id),
  name: text('name').notNull(),
  /** nlh | plo | other */
  game: text('game').notNull().default('nlh'),
  photoUrl: text('photo_url'),
  featured: boolean('featured').notNull().default(false),
  /** cash (Ring Game) | tournament | arena */
  kind: text('kind').notNull().default('cash'),
  /** open | closed | archived */
  status: text('status').notNull().default('closed'),
  dealerId: text('dealer_id').references(() => users.id),
  isAutoDeal: boolean('is_auto_deal').notNull().default(false),
  autoDealSeconds: integer('auto_deal_seconds'),
  /** Empty = every active market, including future ones. */
  markets: text('markets').array().notNull().default(sql`'{}'::text[]`),
  limits: jsonb('limits').$type<TableLimitsJson>().notNull(),
  couponsEnabled: boolean('coupons_enabled').notNull().default(true),
  joinCode: text('join_code').notNull().$defaultFn(() => crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()),
  lastHandNumber: integer('last_hand_number').notNull().default(0),
  lastHandAt: timestamp('last_hand_at', { withTimezone: true }),
  tournamentId: text('tournament_id'),
  createdAt: createdAt(),
}, (t) => [index('club_tables_club_idx').on(t.clubId), uniqueIndex('club_tables_join_code_uq').on(t.joinCode)]);

export type HandStatus = 'betting_open' | 'betting_closed' | 'settled' | 'cancelled';

export const hands = pgTable('hands', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  tableId: text('table_id').notNull().references(() => clubTables.id),
  tournamentId: text('tournament_id'),
  handNumber: integer('hand_number').notNull(),
  status: text('status').$type<HandStatus>().notNull().default('betting_open'),
  /** dealer | auto */
  dealtBy: text('dealt_by').notNull().default('dealer'),
  dealerId: text('dealer_id').references(() => users.id),
  card1: text('card1'),
  card2: text('card2'),
  card3: text('card3'),
  matchingSlugs: text('matching_slugs').array(),
  totalBets: integer('total_bets').notNull().default(0),
  winningBets: integer('winning_bets').notNull().default(0),
  totalWageredCents: cents('total_wagered_cents').notNull().default(0),
  totalPaidOutCents: cents('total_paid_out_cents').notNull().default(0),
  bettingClosesAt: timestamp('betting_closes_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('hands_table_number_uq').on(t.tableId, t.handNumber),
  index('hands_club_created_idx').on(t.clubId, t.createdAt),
]);

// ───────────────────────────── Coupons ─────────────────────────────

export type CouponStatus = 'live' | 'completed' | 'voided';

export const coupons = pgTable('coupons', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  tableId: text('table_id').notNull().references(() => clubTables.id),
  tournamentId: text('tournament_id'),
  userId: text('user_id').notNull().references(() => users.id),
  /** points | chips | stars */
  unit: text('unit').notNull().default('points'),
  rounds: integer('rounds').notNull(),
  roundsSettled: integer('rounds_settled').notNull().default(0),
  status: text('status').$type<CouponStatus>().notNull().default('live'),
  committedCents: cents('committed_cents').notNull(),
  wonCents: cents('won_cents').notNull().default(0),
  refundedCents: cents('refunded_cents').notNull().default(0),
  /** Earliest hand number this coupon may play (current hand if picks were open). */
  startHandNumber: integer('start_hand_number').notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index('coupons_table_status_idx').on(t.tableId, t.status),
  index('coupons_user_idx').on(t.userId, t.createdAt),
]);

export const couponLegs = pgTable('coupon_legs', {
  id: id(),
  couponId: text('coupon_id').notNull().references(() => coupons.id),
  market: text('market').notNull(),
  stakeCents: cents('stake_cents').notNull(),
  /** Multiplier × 100, locked at placement (230 = ×2.3). */
  multiplierX100: integer('multiplier_x100').notNull(),
  /** active | cancelled */
  status: text('status').notNull().default('active'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
}, (t) => [index('coupon_legs_coupon_idx').on(t.couponId)]);

export type BetStatus = 'pending' | 'won' | 'lost' | 'refunded' | 'voided';

/** One leg of one coupon on one hand (a coupon "round" materialized). */
export const bets = pgTable('bets', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  handId: text('hand_id').notNull().references(() => hands.id),
  couponId: text('coupon_id').notNull().references(() => coupons.id),
  legId: text('leg_id').notNull().references(() => couponLegs.id),
  userId: text('user_id').notNull().references(() => users.id),
  market: text('market').notNull(),
  stakeCents: cents('stake_cents').notNull(),
  multiplierX100: integer('multiplier_x100').notNull(),
  status: text('status').$type<BetStatus>().notNull().default('pending'),
  payoutCents: cents('payout_cents').notNull().default(0),
  roundNumber: integer('round_number').notNull(),
  voidReason: text('void_reason'),
  createdAt: createdAt(),
}, (t) => [
  index('bets_hand_idx').on(t.handId),
  index('bets_coupon_idx').on(t.couponId),
  uniqueIndex('bets_leg_hand_uq').on(t.legId, t.handId),
]);

// ───────────────────────────── Platform ─────────────────────────────

/** Platform-wide market catalogue; prices here override the engine defaults. */
export const betTypes = pgTable('bet_types', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  multiplierX100: integer('multiplier_x100').notNull(),
  active: boolean('active').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only audit trail for staff and admin actions. */
export const auditLog = pgTable('audit_log', {
  id: id(),
  clubId: text('club_id'),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  data: jsonb('data').$type<Record<string, unknown>>(),
  createdAt: createdAt(),
}, (t) => [index('audit_club_created_idx').on(t.clubId, t.createdAt)]);
