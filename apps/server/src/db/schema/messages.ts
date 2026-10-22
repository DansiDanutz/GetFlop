import { boolean, index, jsonb, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { clubs, users } from './core.js';

const id = () => text('id').primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const at = (name: string) => timestamp(name, { withTimezone: true });

/** Button attached to a message: opens a table or a tournament. `label` is the target name when written. */
export interface MessageActionJson {
  readonly type: 'table' | 'tournament';
  readonly ref: string;
  readonly label: string;
}

export type MessageStatus = 'scheduled' | 'sent' | 'cancelled' | 'failed';

/** A club message (announcement to an audience, or a direct message to one member). The club is the sender. */
export const clubMessages = pgTable('club_messages', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  authorId: text('author_id').notNull().references(() => users.id),
  /** Audience key (all, active_7 …) or 'member' for a direct message. */
  audience: text('audience').notNull(),
  recipientId: text('recipient_id').references(() => users.id),
  title: text('title'),
  body: text('body').notNull(),
  /** Base64 image data (≤ 120 KB decoded) and its MIME type. */
  photoData: text('photo_data'),
  photoMime: text('photo_mime'),
  action: jsonb('action').$type<MessageActionJson>(),
  /** Writer's IANA timezone: month-based audiences are counted in it. */
  tz: text('tz').notNull().default('UTC'),
  status: text('status').$type<MessageStatus>().notNull(),
  /** writer_gone | nobody | member_left | interrupted */
  failReason: text('fail_reason'),
  sendAt: at('send_at'),
  sentAt: at('sent_at'),
  cancelledAt: at('cancelled_at'),
  recipientCount: integer('recipient_count').notNull().default(0),
  mutedCount: integer('muted_count').notNull().default(0),
  cappedCount: integer('capped_count').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  index('club_messages_club_created_idx').on(t.clubId, t.createdAt),
  index('club_messages_status_send_idx').on(t.status, t.sendAt),
]);

/** One delivered copy of a message; the source of the inbox and of the reach / open / tap stats. */
export const messageRecipients = pgTable('message_recipients', {
  id: id(),
  messageId: text('message_id').notNull().references(() => clubMessages.id),
  clubId: text('club_id').notNull().references(() => clubs.id),
  userId: text('user_id').notNull().references(() => users.id),
  /** Direct messages ignore mute and the daily cap and do not count towards it. */
  isDirect: boolean('is_direct').notNull().default(false),
  deliveredAt: at('delivered_at').notNull(),
  readAt: at('read_at'),
  cardShownAt: at('card_shown_at'),
  tappedAt: at('tapped_at'),
}, (t) => [
  uniqueIndex('message_recipients_uq').on(t.messageId, t.userId),
  index('message_recipients_user_idx').on(t.userId, t.deliveredAt),
  index('message_recipients_club_user_idx').on(t.clubId, t.userId, t.deliveredAt),
]);

/** A member's per-club switch for announcements. */
export const messagePrefs = pgTable('message_prefs', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  userId: text('user_id').notNull().references(() => users.id),
  promoMuted: boolean('promo_muted').notNull().default(false),
  updatedAt: at('updated_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('message_prefs_uq').on(t.clubId, t.userId)]);

/** "Not now" on a suggestion hides it for a while. */
export const messageSuggestionDismissals = pgTable('message_suggestion_dismissals', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  key: text('key').notNull(),
  dismissedBy: text('dismissed_by').notNull().references(() => users.id),
  dismissedAt: at('dismissed_at').notNull(),
}, (t) => [uniqueIndex('message_suggestion_dismissals_uq').on(t.clubId, t.key)]);
