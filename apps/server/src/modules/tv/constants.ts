/** TV module limits. */
export const PAIRING_TTL_MINUTES = 10;
export const PAIRING_CODE_DIGITS = 6;
/** How many random codes to try before giving up with tv.pairing_unavailable. */
export const PAIRING_CODE_ATTEMPTS = 8;
/** A paired display plays for 24 hours. */
export const DISPLAY_TTL_MS = 24 * 60 * 60 * 1000;
/** Failed claims allowed per address per window before tv.pairing_rate_limited. */
export const CLAIM_MAX_FAILURES = 10;
export const CLAIM_WINDOW_MS = 5 * 60 * 1000;
/** Ring Game TV lists. */
export const RECENT_FLOPS = 5;
export const POPULAR_MARKETS = 6;
/** Tournament TV leaderboard rows before "+n more". */
export const LEADERBOARD_VISIBLE = 10;
/** Longest delay setTimeout accepts. */
export const MAX_TIMER_MS = 2_147_483_647;

export const TV_PATH = { cash: '/tv/cash', tournament: '/tv/tournament' } as const;
