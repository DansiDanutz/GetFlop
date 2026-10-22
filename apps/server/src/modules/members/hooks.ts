import type { AppContext } from '../../context.js';
import type { Tx } from '../../db/client.js';

export interface MembershipEnd {
  readonly clubId: string;
  readonly userId: string;
  /** leave = the member leaves; remove = staff removes them. */
  readonly reason: 'leave' | 'remove';
}

/**
 * Blockers other modules add for ending a membership (for example tournaments throw
 * `club.leave_tournament {tournament}` while the member is entered). Register at module top level.
 */
export type MembershipGuard = (ctx: AppContext, tx: Tx, end: MembershipEnd) => Promise<void>;
export const membershipGuards: MembershipGuard[] = [];

/** Extra delete-check blockers contributed by other modules (tournaments upcoming or running …). */
export type DeleteBlockerCount = (ctx: AppContext, clubId: string) => Promise<Record<string, number>>;
export const deleteBlockerCounters: DeleteBlockerCount[] = [];
