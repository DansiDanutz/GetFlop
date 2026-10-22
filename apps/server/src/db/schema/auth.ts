import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Sessions ended by the server (signed in elsewhere, PIN changed, account deleted).
 * Kept so the old device learns why with `auth.session_ended {reason, deviceLabel}`.
 */
export const sessionRevocations = pgTable('session_revocations', {
  /** sha256 of the revoked token (same as sessions.id). */
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  /** other_device | pin_change | pin_reset | account_deleted */
  reason: text('reason').notNull(),
  /** Device family of the new sign-in (other_device only). */
  deviceLabel: text('device_label'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('session_revocations_user_idx').on(t.userId)]);
