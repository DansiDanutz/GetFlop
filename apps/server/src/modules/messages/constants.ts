/** Rules for club messages (08 §6). */
export const TITLE_MAX = 120;
export const BODY_MAX = 2_000;
export const PHOTO_MAX_KB = 120;
export const PHOTO_MAX_BYTES = PHOTO_MAX_KB * 1024;
export const PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** A scheduled message must go out at least this far ahead … */
export const SCHEDULE_MIN_AHEAD_MS = MINUTE_MS;
/** … and at most this many days ahead. */
export const SCHEDULE_MAX_DAYS = 30;

/** At most one group message per player per club in this window. */
export const GROUP_CAP_WINDOW_MS = DAY_MS;

/** A join counts for a message when it follows the button tap within this window (inferred). */
export const JOIN_ATTRIBUTION_MS = DAY_MS;

/** Messaging is free and unlimited until 1 Dec 2026 (00:00 Greek time). Then Level quotas apply. */
export const FREE_MESSAGING_UNTIL = new Date('2026-11-30T22:00:00Z');

/** "Not now" hides a suggestion this long. */
export const SUGGESTION_SNOOZE_MS = 7 * DAY_MS;

export const SENT_PAGE_DEFAULT = 30;
export const SENT_PAGE_MAX = 100;
export const INBOX_LIMIT = 100;
export const PLAYERS_LIMIT = 50;

/** Scheduled delivery job interval. */
export const DELIVERY_JOB_EVERY_MS = 15_000;

export const AUDIENCE_KEYS = [
  'all', 'active_7', 'active_30', 'inactive_30', 'new_14',
  'ring_month', 'tourney_month', 'top_active', 'staff',
] as const;
export type AudienceKey = (typeof AUDIENCE_KEYS)[number];
export const MEMBER_AUDIENCE = 'member';

/** Top-active audience: the top share of recent players, never fewer than the minimum. */
export const TOP_ACTIVE_SHARE = 0.1;
export const TOP_ACTIVE_MIN = 5;

export type FailReason = 'writer_gone' | 'nobody' | 'member_left' | 'interrupted';
