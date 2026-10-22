// Tables for the inspector (floor) module.
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { clubs, users } from './core.js';

/**
 * Floor sessions ("shifts"): an analytics window opened and closed by the floor.
 * Closes itself at 06:00 club local time when nobody closes it.
 */
export const floorSessions = pgTable('floor_sessions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  clubId: text('club_id').notNull().references(() => clubs.id),
  /** Sequential per club, from 1. */
  number: integer('number').notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
  openedBy: text('opened_by').references(() => users.id),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: text('closed_by').references(() => users.id),
  /** manual | auto (06:00 cut-off) */
  closedReason: text('closed_reason'),
  /** Totals frozen at close: hands, players, handleCents, resultCents. */
  summary: jsonb('summary').$type<Record<string, number>>(),
}, (t) => [
  uniqueIndex('floor_sessions_club_number_uq').on(t.clubId, t.number),
  index('floor_sessions_club_opened_idx').on(t.clubId, t.openedAt),
]);

/** Platform-wide floor switches (simulation budget trip …). One row per key. */
export const floorFlags = pgTable('floor_flags', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
