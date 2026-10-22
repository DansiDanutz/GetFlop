import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx, Tx } from '../../db/client.js';
import {
  clubBilling, clubs, commerceAlerts, commerceAudit, diamondOrders, diamondRefunds, memberships, topupRequests, users,
} from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { getBilling, getBillingStart, isEnforced, setBillingStart, updateBilling } from './billing.js';
import { levelOffer } from './catalogue.js';
import { BILLING_START_MIN_HOURS, commerceConfig, REFUND_WINDOW_DAYS } from './config.js';
import { clubState, dashboard } from './dashboard.js';
import { accountMessage, audit } from './notify.js';
import { cardPayments } from './orders.js';
import { receipts } from './receipts.js';

const LIST_LIMIT = 50;
const HOUR_MS = 3_600_000;
const ATHENS = 'Europe/Athens';

/** 12:00 Greek time on `day` (YYYY-MM-DD) as an instant, or null when the day is not a real date. */
export function athensNoon(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const probe = new Date(Date.UTC(y, mo, d, 12));
  if (probe.getUTCMonth() !== mo || probe.getUTCDate() !== d) return null;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: ATHENS, hour: '2-digit', hour12: false }).format(probe));
  return new Date(probe.getTime() - (hour - 12) * HOUR_MS);
}

export async function adminClubList(db: DbOrTx, q: string | undefined, at: Date) {
  const search = q?.trim();
  const where = and(eq(clubs.status, 'active'), search ? or(ilike(clubs.name, `%${search}%`), eq(clubs.publicId, search)) : undefined);
  const rows = await db.select().from(clubs).where(where).orderBy(clubs.name).limit(LIST_LIMIT);
  const [total] = await db.select({ n: count() }).from(clubs).where(where);
  const ids = rows.map((r) => r.id);
  const memberCounts = ids.length === 0 ? [] : await db.select({ clubId: memberships.clubId, n: count() }).from(memberships)
    .where(and(inArray(memberships.clubId, ids), eq(memberships.status, 'active'))).groupBy(memberships.clubId);
  const requests = ids.length === 0 ? [] : await db.select({ clubId: topupRequests.clubId, n: count() }).from(topupRequests)
    .where(and(inArray(topupRequests.clubId, ids), eq(topupRequests.status, 'pending'))).groupBy(topupRequests.clubId);
  const list = [];
  for (const club of rows) {
    const s = await clubState(db, club.id, at);
    const level = await levelOffer(db, s.billing.levelCode, at);
    list.push({
      id: club.id, publicId: club.publicId, name: club.name, diamondsD: s.balanceD, unpaidD: s.pendingD,
      level: s.billing.levelCode, levelName: level?.name ?? s.billing.levelCode, renewsAt: s.billing.renewsAt,
      state: s.state, billing: s.enforced ? 'on' : 'pilot',
      members: memberCounts.find((m) => m.clubId === club.id)?.n ?? 0,
      diamondRequests: requests.find((r) => r.clubId === club.id)?.n ?? 0,
    });
  }
  return { clubs: list, total: total?.n ?? 0, billingStart: await getBillingStart(db), pilotForced: commerceConfig().pilot };
}

export async function adminClubDetail(db: DbOrTx, clubId: string, at: Date) {
  const [club] = await db.select().from(clubs).where(eq(clubs.id, clubId));
  if (!club) throw new AppError('club.not_found', 404);
  const requests = await db.select().from(topupRequests).where(eq(topupRequests.clubId, clubId)).orderBy(desc(topupRequests.createdAt)).limit(LIST_LIMIT);
  return { ...(await dashboard(db, clubId, at)), club: { id: club.id, name: club.name, publicId: club.publicId, ownerId: club.ownerId }, requests };
}

export async function setEnforcement(ctx: AppContext, tx: Tx, actorId: string, clubId: string, enabled: boolean) {
  await getBilling(tx, clubId, ctx.now());
  const row = await updateBilling(tx, clubId, { enforced: enabled }, ctx.now());
  await accountMessage(ctx, tx, clubId, enabled ? 'billing_enforced' : 'billing_pilot', {});
  await audit(ctx, tx, actorId, 'club_billing_switched', { type: 'club', id: clubId }, { enabled });
  return { enforced: row.enforced, effective: isEnforced(row) };
}

async function tellEveryOwner(ctx: AppContext, tx: Tx, code: string, params: Record<string, string | number>): Promise<void> {
  const all = await tx.select({ id: clubs.id }).from(clubs).where(eq(clubs.status, 'active'));
  for (const c of all) await accountMessage(ctx, tx, c.id, code, params);
}

export async function scheduleBillingStart(ctx: AppContext, tx: Tx, actorId: string, day: string) {
  const at = ctx.now();
  const startAt = athensNoon(day);
  if (!startAt) throw new AppError('commerce.billing_start_date_invalid');
  const current = await getBillingStart(tx);
  if (current?.applied) throw new AppError('commerce.billing_start_already_live', 409);
  if (startAt.getTime() - at.getTime() < BILLING_START_MIN_HOURS * HOUR_MS) {
    throw new AppError('commerce.billing_start_too_soon', 409, { hours: BILLING_START_MIN_HOURS });
  }
  const value = { day, at: startAt.toISOString(), applied: false };
  await setBillingStart(tx, value, at);
  await tellEveryOwner(ctx, tx, 'billing_start', { date: value.at });
  await audit(ctx, tx, actorId, 'billing_start_scheduled', { type: 'platform', id: 'billing_start' }, { day });
  return value;
}

export async function postponeBillingStart(ctx: AppContext, tx: Tx, actorId: string) {
  const current = await getBillingStart(tx);
  if (current?.applied) throw new AppError('commerce.billing_start_already_live', 409);
  if (!current) return { billingStart: null };
  await setBillingStart(tx, null, ctx.now());
  await tellEveryOwner(ctx, tx, 'billing_postponed', {});
  await audit(ctx, tx, actorId, 'billing_start_postponed', { type: 'platform', id: 'billing_start' }, { day: current.day });
  return { billingStart: null };
}

/** "Return every club to the pilot": clears the start and switches every club back to previews. */
export async function returnAllToPilot(ctx: AppContext, tx: Tx, actorId: string) {
  await setBillingStart(tx, null, ctx.now());
  await tx.update(clubBilling).set({ enforced: false, updatedAt: ctx.now() });
  await tellEveryOwner(ctx, tx, 'billing_pilot', {});
  await audit(ctx, tx, actorId, 'club_billing_switched', { type: 'platform', id: 'all' }, { enabled: false });
  return { ok: true };
}

export async function paymentsOverview(db: DbOrTx) {
  const cfg = commerceConfig();
  const alerts = await db.select().from(commerceAlerts).orderBy(desc(commerceAlerts.createdAt)).limit(LIST_LIMIT);
  const orders = await db.select({ order: diamondOrders, club: clubs.name, buyer: users.username }).from(diamondOrders)
    .innerJoin(clubs, eq(clubs.id, diamondOrders.clubId)).innerJoin(users, eq(users.id, diamondOrders.buyerId))
    .orderBy(desc(diamondOrders.createdAt)).limit(LIST_LIMIT);
  const refunds = orders.length === 0 ? [] : await db.select().from(diamondRefunds).where(inArray(diamondRefunds.orderId, orders.map((o) => o.order.id)));
  const pendingRequests = await db.select({ n: count() }).from(topupRequests).where(eq(topupRequests.status, 'pending'));
  return {
    config: {
      cardPayments: cardPayments(), vat: cfg.stripeTax, receiptsMode: receipts().mode, refundWindowDays: REFUND_WINDOW_DAYS,
      webhookConfigured: Boolean(cfg.stripeWebhookSecret), pilotForced: cfg.pilot,
    },
    alerts, unreadAlerts: alerts.filter((a) => !a.readAt).length,
    orders: orders.map(({ order, club, buyer }) => ({ ...order, clubName: club, buyer, refund: refunds.find((r) => r.orderId === order.id) ?? null })),
    diamondRequests: pendingRequests[0]?.n ?? 0,
  };
}

export async function markAlertsRead(ctx: AppContext) {
  await ctx.db.update(commerceAlerts).set({ readAt: ctx.now() }).where(isNull(commerceAlerts.readAt));
  return { ok: true };
}

export async function auditList(db: DbOrTx, limit: number, offset: number) {
  const rows = await db.select({ entry: commerceAudit, actor: users.username }).from(commerceAudit)
    .leftJoin(users, eq(users.id, commerceAudit.actorId))
    .orderBy(desc(commerceAudit.createdAt)).limit(limit).offset(offset);
  const [total] = await db.select({ n: sql<number>`count(*)::int` }).from(commerceAudit);
  return { entries: rows.map((r) => ({ ...r.entry, actor: r.actor })), total: total?.n ?? 0 };
}
