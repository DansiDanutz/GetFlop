import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { accountMessages, clubs, commerceAlerts, commerceAudit } from '../../db/schema/index.js';
import { rooms } from '../../realtime/events.js';

export type MessageParams = Record<string, string | number>;

/**
 * Writes a club account message (shown as msg_<code> in the owner's Club account)
 * and pings the owner's sockets so the account view refreshes.
 */
export async function accountMessage(ctx: AppContext, db: DbOrTx, clubId: string, code: string, params: MessageParams = {}): Promise<void> {
  await db.insert(accountMessages).values({ clubId, code, params, createdAt: ctx.now() });
  const [club] = await db.select({ ownerId: clubs.ownerId }).from(clubs).where(eq(clubs.id, clubId));
  if (club) ctx.events.emit(rooms.user(club.ownerId), 'commerce:changed', { clubId, code });
}

/** A platform alert for the admin Payments tab. */
export async function alert(ctx: AppContext, db: DbOrTx, kind: string, data: Record<string, unknown>, refs: { clubId?: string; orderId?: string } = {}): Promise<void> {
  await db.insert(commerceAlerts).values({ kind, data, clubId: refs.clubId ?? null, orderId: refs.orderId ?? null, createdAt: ctx.now() });
  ctx.logger.info(`[commerce] alert ${kind}`, { ...refs, kind });
}

/** Commerce audit entry (catalogue, billing switches, codes, top-ups, refunds). */
export async function audit(
  ctx: AppContext, db: DbOrTx, actorId: string | null, action: string,
  entity: { type: string; id: string }, data: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(commerceAudit).values({
    actorId, action, entityType: entity.type, entityId: entity.id, data, createdAt: ctx.now(),
  });
}
