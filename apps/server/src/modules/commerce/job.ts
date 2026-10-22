import { and, isNotNull, isNull, lte } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { clubBilling } from '../../db/schema/index.js';
import { getBilling, getBillingStart, isEnforced, isPaused, setBillingStart, updateBilling } from './billing.js';
import { levelOffer } from './catalogue.js';
import { addDays } from './config.js';
import { renewClub } from './levelChange.js';
import { accountMessage } from './notify.js';
import { expireLots } from './wallet.js';

export const BILLING_JOB_MS = 60_000;
const REMINDER_DAYS_BEFORE = 3;

/** Once the scheduled billing start has passed, every club is switched to enforced. */
async function applyBillingStart(ctx: AppContext): Promise<void> {
  const start = await getBillingStart(ctx.db);
  if (!start || start.applied || new Date(start.at) > ctx.now()) return;
  await ctx.db.transaction(async (tx) => {
    await tx.update(clubBilling).set({ enforced: true, updatedAt: ctx.now() });
    await setBillingStart(tx, { ...start, applied: true }, ctx.now());
  });
}

async function expire(ctx: AppContext): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const expired = await expireLots(tx, ctx.now());
    for (const [clubId, amount] of expired) await accountMessage(ctx, tx, clubId, 'diamonds_expired', { amount });
  });
}

async function renewDue(ctx: AppContext): Promise<number> {
  const due = await ctx.db.select({ clubId: clubBilling.clubId }).from(clubBilling)
    .where(and(isNotNull(clubBilling.renewsAt), lte(clubBilling.renewsAt, ctx.now())));
  for (const { clubId } of due) {
    try {
      await ctx.db.transaction(async (tx) => { await renewClub(ctx, tx, await getBilling(tx, clubId, ctx.now())); });
    } catch (err) {
      ctx.logger.error('Level renewal failed', { clubId, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return due.length;
}

async function remind(ctx: AppContext): Promise<void> {
  const at = ctx.now();
  const soon = await ctx.db.select().from(clubBilling)
    .where(and(isNotNull(clubBilling.renewsAt), lte(clubBilling.renewsAt, addDays(at, REMINDER_DAYS_BEFORE))));
  for (const b of soon) {
    if (!b.renewsAt || b.reminderSentFor?.getTime() === b.renewsAt.getTime()) continue;
    const offer = await levelOffer(ctx.db, b.pendingDowngradeCode ?? b.levelCode, at);
    await ctx.db.transaction(async (tx) => {
      await accountMessage(ctx, tx, b.clubId, 'renewal_reminder', {
        level: offer?.name ?? b.levelCode, date: b.renewsAt!.toISOString(), costD: offer?.priceD ?? 0, preview: isEnforced(b) ? 0 : 1,
      });
      await updateBilling(tx, b.clubId, { reminderSentFor: b.renewsAt }, at);
    });
  }
}

/** Tells the owner once when new hands pause. */
async function notifyPauses(ctx: AppContext): Promise<void> {
  const rows = await ctx.db.select().from(clubBilling).where(isNull(clubBilling.pausedNotifiedAt));
  for (const b of rows) {
    if (!isEnforced(b) || !(await isPaused(ctx.db, b.clubId, ctx.now()))) continue;
    await ctx.db.transaction(async (tx) => {
      await accountMessage(ctx, tx, b.clubId, 'play_paused', {});
      await updateBilling(tx, b.clubId, { pausedNotifiedAt: ctx.now() }, ctx.now());
    });
  }
}

/** The commerce job: billing start, lot expiry, renewals, reminders, pause notices. */
export async function runBilling(ctx: AppContext): Promise<void> {
  await applyBillingStart(ctx);
  await expire(ctx);
  await renewDue(ctx);
  await remind(ctx);
  await notifyPauses(ctx);
}
