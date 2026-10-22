import { boolean, index, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { clubs, users } from './core.js';

// Tables for the members module (club notices, onboarding, per-member preferences).

/** Server-generated notices for one user ("club deleted", "pool short", "staff sent a join request for you" …). */
export const clubNotices = pgTable('club_notices', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').notNull().references(() => users.id),
  clubId: text('club_id').references(() => clubs.id),
  /** Dotted code; the web shows notice_<code>. */
  code: text('code').notNull(),
  params: jsonb('params').$type<Record<string, string | number>>().notNull().default({}),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('club_notices_user_idx').on(t.userId, t.readAt)]);

/** Coach marks / intro steps a user has seen, per scenario (player, dealer, inspector, manager, owner). */
export const onboardingSeen = pgTable('onboarding_seen', {
  userId: text('user_id').notNull().references(() => users.id),
  scenario: text('scenario').notNull(),
  code: text('code').notNull(),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.scenario, t.code] })]);

/** Per-member preferences inside one club. */
export const memberPrefs = pgTable('member_prefs', {
  clubId: text('club_id').notNull().references(() => clubs.id),
  userId: text('user_id').notNull().references(() => users.id),
  /** Shows the member as "Member" on the club board. */
  boardHidden: boolean('board_hidden').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.clubId, t.userId] })]);
