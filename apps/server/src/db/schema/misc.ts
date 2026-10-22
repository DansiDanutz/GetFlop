// Tables for the misc module are declared here.
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { clubTables, clubs, users } from './core.js';

// ───────────────────────────── Dealer ─────────────────────────────

/** pending → approved | rejected | cancelled | taken (table got a dealer) | busy (dealer went elsewhere). */
export type DealerSitStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'taken' | 'busy';

/** A dealer asking to sit at a table in a club that requires the floor's approval. */
export const dealerSitRequests = pgTable('dealer_sit_requests', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  clubId: text('club_id').notNull().references(() => clubs.id),
  tableId: text('table_id').notNull().references(() => clubTables.id),
  dealerId: text('dealer_id').notNull().references(() => users.id),
  status: text('status').$type<DealerSitStatus>().notNull().default('pending'),
  reviewedBy: text('reviewed_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('dealer_sit_requests_club_status_idx').on(t.clubId, t.status),
  // A dealer has at most one pending request (dealer.request_pending).
  uniqueIndex('dealer_sit_requests_one_pending_uq').on(t.dealerId).where(sql`${t.status} = 'pending'`),
]);

/** Persistent notices for a dealer (e.g. dealer.wanted_elsewhere). Unread until marked read. */
export const dealerNotices = pgTable('dealer_notices', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').notNull().references(() => users.id),
  code: text('code').notNull(),
  params: jsonb('params').$type<Record<string, string | number>>().notNull().default({}),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('dealer_notices_user_idx').on(t.userId)]);

// ───────────────────────────── TV ─────────────────────────────

/** What a TV follows: a Ring Game table or a tournament. */
export type TvKind = 'cash' | 'tournament';

/** A 6-digit code created on a staff phone and typed into a TV. Short-lived and single use. */
export const tvPairings = pgTable('tv_pairings', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  clubId: text('club_id').notNull().references(() => clubs.id),
  kind: text('kind').$type<TvKind>().notNull(),
  /** Table id (cash) or tournament id (tournament). */
  targetId: text('target_id').notNull(),
  code: text('code').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  /** Set when a newer code for the same target replaces this one. */
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  sessionId: text('session_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('tv_pairings_code_idx').on(t.code),
  index('tv_pairings_target_idx').on(t.kind, t.targetId),
]);

/** A paired TV display. The display token is only stored as a sha256 hash. */
export const tvSessions = pgTable('tv_sessions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  clubId: text('club_id').notNull().references(() => clubs.id),
  kind: text('kind').$type<TvKind>().notNull(),
  targetId: text('target_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  /** pairing (6-digit code) | link (direct link fallback) */
  via: text('via').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('tv_sessions_token_uq').on(t.tokenHash),
  index('tv_sessions_target_idx').on(t.kind, t.targetId),
]);
