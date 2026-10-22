import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { memberships } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { can, type ClubAccess } from '../clubs/access.js';
import { heldTable, standUp } from '../game/dealer.js';
import { liveHand, setTableLimits, setTableMarkets, type TableRow } from '../game/tables.js';

export interface OpenPrep {
  /** The table the dealer was stood up from (leaveHeld). */
  readonly left: { readonly tableId: string; readonly tableName: string } | null;
  /** The owner or manager chose "Me — I'll deal" and was given the dealer role. */
  readonly grantedSelfDealer: boolean;
}

/** "Me — I'll deal": an owner or manager picking themselves gets the dealer role (00 §3.3: own card, dealer only). */
async function grantSelfDealer(ctx: AppContext, access: ClubAccess): Promise<boolean> {
  if (access.roles.includes('dealer')) return false;
  if (access.rank < 3 || !access.membership) throw new AppError('dealer.not_found', 404);
  await ctx.db.update(memberships).set({ roles: sql`array_append(${memberships.roles}, 'dealer')` })
    .where(and(eq(memberships.id, access.membership.id), eq(memberships.status, 'active')));
  ctx.events.emit(rooms.user(access.user.id), 'club:context-changed', { clubId: access.club.id });
  return true;
}

/**
 * Runs before PUT /inspector/table/:id/open seats the chosen dealer:
 * grants the self-deal role when needed, and with `leaveHeld` stands the dealer up
 * at the other table of this club they hold.
 */
export async function prepareOpen(
  ctx: AppContext, access: ClubAccess, tableId: string, dealerId: string | null | undefined, leaveHeld: boolean,
): Promise<OpenPrep> {
  if (!dealerId) return { left: null, grantedSelfDealer: false };
  const grantedSelfDealer = dealerId === access.user.id ? await grantSelfDealer(ctx, access) : false;
  if (!leaveHeld) return { left: null, grantedSelfDealer };
  const held = await heldTable(ctx.db, dealerId);
  if (!held || held.table.id === tableId || held.table.clubId !== access.club.id) return { left: null, grantedSelfDealer };
  const hand = await liveHand(ctx.db, held.table.id);
  if (hand) throw new AppError('dealer.hand_live', 409, { hand: hand.handNumber });
  await standUp(ctx, access.club.id, held.table.id, dealerId, 'floor');
  return { left: { tableId: held.table.id, tableName: held.table.name }, grantedSelfDealer };
}

export const createExtrasSchema = z.object({
  allowedBetTypeIds: z.array(z.string().max(40)).max(100).optional(),
  minBetCents: z.number().int().optional(),
  maxBetCents: z.number().int().optional(),
  maxCouponCommitmentCents: z.number().int().optional(),
});

/**
 * POST /inspector/table extras (07 §2.1): the allowed markets, and the limits when the
 * creator is an owner or manager (others' limit fields are ignored, defaults apply).
 */
export async function applyCreateExtras(ctx: AppContext, access: ClubAccess, table: TableRow, raw: unknown): Promise<TableRow> {
  const extras = createExtrasSchema.parse(raw ?? {});
  let current = table;
  if (extras.allowedBetTypeIds && extras.allowedBetTypeIds.length > 0) {
    current = await setTableMarkets(ctx, access, current.id, extras.allowedBetTypeIds);
  }
  const hasLimits = [extras.minBetCents, extras.maxBetCents, extras.maxCouponCommitmentCents].some((v) => v !== undefined);
  if (hasLimits && can(access, 'limits.edit')) {
    current = await setTableLimits(ctx, access, current.id, {
      ...current.limits,
      minCents: extras.minBetCents ?? current.limits.minCents,
      maxCents: extras.maxBetCents ?? current.limits.maxCents,
      couponCapCents: extras.maxCouponCommitmentCents ?? current.limits.couponCapCents,
      marketMaxCents: current.limits.marketMaxCents ?? {},
    });
  }
  return current;
}
