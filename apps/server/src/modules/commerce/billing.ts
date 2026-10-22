import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { clubBilling, clubs, commerceCharges, commerceSettings, diamondLedger } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { levelOffer } from './catalogue.js';
import {
  addDays, commerceConfig, CRITICAL_RUNWAY_DAYS, DAY_MS, LEVEL_PERIOD_DAYS, LOW_RUNWAY_DAYS,
} from './config.js';

export type BillingRow = typeof clubBilling.$inferSelect;
export type AccountState = 'preview' | 'healthy' | 'low' | 'critical' | 'usage_grace' | 'past_due_grace' | 'restricted';

const BILLING_START_KEY = 'billing_start';

export interface BillingStart {
  /** Greek-time day chosen by the admin (YYYY-MM-DD). */
  readonly day: string;
  /** 12:00 Europe/Athens on that day, as an instant. */
  readonly at: string;
  /** Set once every club has been switched to enforced. */
  readonly applied: boolean;
}

export async function getBillingStart(db: DbOrTx): Promise<BillingStart | null> {
  const [row] = await db.select().from(commerceSettings).where(eq(commerceSettings.key, BILLING_START_KEY));
  return (row?.value as BillingStart | undefined) ?? null;
}

export async function setBillingStart(db: DbOrTx, value: BillingStart | null, at: Date): Promise<void> {
  if (!value) {
    await db.delete(commerceSettings).where(eq(commerceSettings.key, BILLING_START_KEY));
    return;
  }
  await db.insert(commerceSettings).values({ key: BILLING_START_KEY, value, updatedAt: at })
    .onConflictDoUpdate({ target: commerceSettings.key, set: { value, updatedAt: at } });
}

/** The club's billing row, created from the club's Level on first use. */
export async function getBilling(db: DbOrTx, clubId: string, at: Date): Promise<BillingRow> {
  const [found] = await db.select().from(clubBilling).where(eq(clubBilling.clubId, clubId));
  if (found) return found;
  const [club] = await db.select().from(clubs).where(eq(clubs.id, clubId));
  if (!club) throw new AppError('club.not_found', 404);
  const offer = await levelOffer(db, club.level, at);
  const start = await getBillingStart(db);
  const paid = club.level !== 'starter';
  await db.insert(clubBilling).values({
    clubId, levelCode: club.level, levelVersionId: offer?.versionId ?? null,
    periodStartAt: paid ? at : null,
    renewsAt: paid ? club.levelRenewsAt ?? addDays(at, LEVEL_PERIOD_DAYS) : null,
    enforced: Boolean(start?.applied), updatedAt: at,
  }).onConflictDoNothing();
  const [row] = await db.select().from(clubBilling).where(eq(clubBilling.clubId, clubId));
  return row!;
}

export async function updateBilling(db: DbOrTx, clubId: string, patch: Partial<BillingRow>, at: Date): Promise<BillingRow> {
  const [row] = await db.update(clubBilling).set({ ...patch, updatedAt: at }).where(eq(clubBilling.clubId, clubId)).returning();
  return row!;
}

/** Charges are taken only when the server pilot is off and the club is enforced. */
export function isEnforced(billing: BillingRow): boolean {
  return !commerceConfig().pilot && billing.enforced;
}

export interface PendingSummary {
  readonly pendingD: number;
  readonly count: number;
  readonly firstAt: Date | null;
}

export async function pendingCharges(db: DbOrTx, clubId: string) {
  return db.select().from(commerceCharges)
    .where(and(eq(commerceCharges.clubId, clubId), eq(commerceCharges.status, 'pending')))
    .orderBy(asc(commerceCharges.createdAt));
}

export async function pendingSummary(db: DbOrTx, clubId: string): Promise<PendingSummary> {
  const rows = await pendingCharges(db, clubId);
  return { pendingD: rows.reduce((s, r) => s + r.diamonds, 0), count: rows.length, firstAt: rows[0]?.createdAt ?? null };
}

/** When the usage grace ends: first unpaid hand + grace days (or now when pending reached maxD). */
export function usageGraceEnds(p: PendingSummary): Date | null {
  if (!p.firstAt) return null;
  return addDays(p.firstAt, commerceConfig().usageGraceDays);
}

export function isUsagePaused(p: PendingSummary, at: Date): boolean {
  if (p.pendingD <= 0) return false;
  const cfg = commerceConfig();
  return p.pendingD >= cfg.usageMaxPendingD || at >= usageGraceEnds(p)!;
}

export function isRenewalPaused(b: BillingRow, at: Date): boolean {
  return Boolean(b.renewalDeadline && at >= b.renewalDeadline);
}

/** Average Diamonds spent per day over the last 7 days (charges only). */
export async function dailySpend(db: DbOrTx, clubId: string, at: Date): Promise<number | null> {
  const since = new Date(at.getTime() - LOW_RUNWAY_DAYS * DAY_MS);
  const [row] = await db.select({ spent: sql<string>`coalesce(sum(-${diamondLedger.amount}), 0)`, n: sql<string>`count(*)` })
    .from(diamondLedger)
    .where(and(eq(diamondLedger.clubId, clubId), gte(diamondLedger.createdAt, since),
      inArray(diamondLedger.type, ['usage_charge', 'level_charge', 'charge_settlement'])));
  const n = Number(row?.n ?? 0);
  return n === 0 ? null : Number(row?.spent ?? 0) / LOW_RUNWAY_DAYS;
}

export interface StateInput {
  readonly billing: BillingRow;
  readonly balance: number;
  readonly pending: PendingSummary;
  readonly renewalPriceD: number;
  readonly perDay: number | null;
  readonly at: Date;
}

export function accountState(i: StateInput): AccountState {
  if (!isEnforced(i.billing)) return 'preview';
  if (isRenewalPaused(i.billing, i.at) || isUsagePaused(i.pending, i.at)) return 'restricted';
  if (i.billing.renewalOverdueSince) return 'past_due_grace';
  if (i.pending.pendingD > 0) return 'usage_grace';
  const available = i.balance - scheduledD(i.billing, i.renewalPriceD, i.at);
  const runway = i.perDay && i.perDay > 0 ? available / i.perDay : null;
  const renewalSoon = i.billing.renewsAt && i.billing.renewsAt.getTime() - i.at.getTime() < LOW_RUNWAY_DAYS * DAY_MS;
  if ((runway !== null && runway < CRITICAL_RUNWAY_DAYS) || (renewalSoon && i.balance < i.renewalPriceD)) return 'critical';
  if (available < 0 || (runway !== null && runway < LOW_RUNWAY_DAYS)) return 'low';
  return 'healthy';
}

/** Level renewals scheduled in the next 30 days. */
export function scheduledD(b: BillingRow, renewalPriceD: number, at: Date): number {
  if (!b.renewsAt) return 0;
  return b.renewsAt.getTime() - at.getTime() <= LEVEL_PERIOD_DAYS * DAY_MS ? renewalPriceD : 0;
}

/** Is the club paused by billing (only ever when enforced)? */
export async function isPaused(db: DbOrTx, clubId: string, at: Date): Promise<boolean> {
  const billing = await getBilling(db, clubId, at);
  if (!isEnforced(billing)) return false;
  if (isRenewalPaused(billing, at)) return true;
  return isUsagePaused(await pendingSummary(db, clubId), at);
}
