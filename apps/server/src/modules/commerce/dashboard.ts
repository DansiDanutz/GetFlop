import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import {
  accountMessages, clubs, commerceCharges, diamondLedger, diamondOrders, diamondRefunds, topupRequests,
} from '../../db/schema/index.js';
import {
  accountState, dailySpend, getBilling, getBillingStart, isEnforced, pendingSummary, scheduledD, usageGraceEnds,
  type BillingRow,
} from './billing.js';
import { levelOffer, levelOffers, packOffers, scheduledRate, turnoverRateBp } from './catalogue.js';
import { commerceConfig, DAY_MS, LEVEL_PERIOD_DAYS, REFUND_WINDOW_DAYS } from './config.js';
import { clubLimits, freeClubOf, isLevelLocked, usageOf, type Resource } from './limits.js';
import { cardPayments } from './orders.js';
import { balanceOf, nextExpiry } from './wallet.js';

const RESOURCES: readonly Resource[] = ['members', 'rooms', 'ringGames', 'tournaments', 'broadcasts'];
const LEDGER_PAGE = 50;
const RECENT_CHARGES = 5;
const MESSAGES_SHOWN = 30;

async function renewalPrice(db: DbOrTx, billing: BillingRow, at: Date): Promise<number> {
  const code = billing.pendingDowngradeCode ?? billing.levelCode;
  return (await levelOffer(db, code, at))?.priceD ?? 0;
}

/** "Diamond chip": balance and account state. */
export async function clubState(db: DbOrTx, clubId: string, at: Date) {
  const billing = await getBilling(db, clubId, at);
  const balance = await balanceOf(db, clubId);
  const pending = await pendingSummary(db, clubId);
  const price = await renewalPrice(db, billing, at);
  const perDay = await dailySpend(db, clubId, at);
  const state = accountState({ billing, balance, pending, renewalPriceD: price, perDay, at });
  return { balanceD: balance, state, enforced: isEnforced(billing), pendingD: pending.pendingD, billing, perDay, price, pending };
}

/** Play charge since the start of the current period (Starter: the last 30 days). */
async function periodPlay(db: DbOrTx, clubId: string, since: Date) {
  const [row] = await db.select({
    pointsCents: sql<string>`coalesce(sum(${commerceCharges.pointsCents}), 0)`,
    diamonds: sql<string>`coalesce(sum(${commerceCharges.diamonds}), 0)`,
    charged: sql<string>`coalesce(sum(case when ${commerceCharges.status} in ('charged','settled') then ${commerceCharges.diamonds} else 0 end), 0)`,
    preview: sql<string>`coalesce(sum(case when ${commerceCharges.status} = 'preview' then ${commerceCharges.diamonds} else 0 end), 0)`,
    pending: sql<string>`coalesce(sum(case when ${commerceCharges.status} = 'pending' then ${commerceCharges.diamonds} else 0 end), 0)`,
  }).from(commerceCharges).where(and(
    eq(commerceCharges.clubId, clubId), gte(commerceCharges.createdAt, since),
    inArray(commerceCharges.kind, ['hand', 'tournament_entry', 'entry_refund', 'usage_legacy']),
  ));
  return {
    since, pointsCents: Number(row?.pointsCents ?? 0), diamonds: Number(row?.diamonds ?? 0),
    chargedD: Number(row?.charged ?? 0), previewD: Number(row?.preview ?? 0), pendingD: Number(row?.pending ?? 0),
  };
}

/** Diamonds spent in the window, split into Level and Play charge. */
async function spend(db: DbOrTx, clubId: string, since: Date) {
  const rows = await db.select({ type: diamondLedger.type, total: sql<string>`coalesce(sum(-${diamondLedger.amount}), 0)` })
    .from(diamondLedger)
    .where(and(eq(diamondLedger.clubId, clubId), gte(diamondLedger.createdAt, since),
      inArray(diamondLedger.type, ['level_charge', 'usage_charge', 'charge_settlement'])))
    .groupBy(diamondLedger.type);
  const of = (t: string) => Number(rows.find((r) => r.type === t)?.total ?? 0);
  return { levelD: of('level_charge'), playD: of('usage_charge') + of('charge_settlement') };
}

export async function ledgerPage(db: DbOrTx, clubId: string, limit = LEDGER_PAGE, before?: Date) {
  const where = before ? and(eq(diamondLedger.clubId, clubId), lt(diamondLedger.createdAt, before)) : eq(diamondLedger.clubId, clubId);
  return db.select().from(diamondLedger).where(where).orderBy(desc(diamondLedger.createdAt), desc(diamondLedger.id)).limit(limit);
}

export async function chargesPage(db: DbOrTx, clubId: string, limit: number, before?: Date) {
  const where = before
    ? and(eq(commerceCharges.clubId, clubId), lt(commerceCharges.createdAt, before))
    : eq(commerceCharges.clubId, clubId);
  return db.select().from(commerceCharges).where(where).orderBy(desc(commerceCharges.createdAt)).limit(limit);
}

async function levelsTable(db: DbOrTx, currentCode: string, at: Date) {
  const offers = await levelOffers(db, at);
  const current = offers.find((o) => o.code === currentCode)?.rank ?? 0;
  return offers.map((o) => ({
    productId: o.productId, code: o.code, name: o.name, nameEl: o.nameEl, priceD: o.priceD, limits: o.limits, onSale: o.onSale,
    current: o.code === currentCode, direction: o.rank > current ? 'upgrade' : o.rank < current ? 'downgrade' : 'same',
  }));
}

async function orderList(db: DbOrTx, clubId: string) {
  const orders = await db.select().from(diamondOrders)
    .where(and(eq(diamondOrders.clubId, clubId), inArray(diamondOrders.status, ['paid', 'refunded'])))
    .orderBy(desc(diamondOrders.createdAt)).limit(LEDGER_PAGE);
  const refunds = orders.length === 0 ? [] : await db.select().from(diamondRefunds).where(inArray(diamondRefunds.orderId, orders.map((o) => o.id)));
  return orders.map((o) => {
    const refund = refunds.find((r) => r.orderId === o.id);
    return {
      id: o.id, status: o.status, diamonds: o.diamonds, netCents: o.paidSubtotalCents ?? o.netCents, vatCents: o.vatCents ?? 0,
      totalCents: o.totalCents ?? o.netCents, isTest: o.isTest, paidAt: o.paidAt, receiptStatus: o.receiptStatus,
      hasReceipt: Boolean(o.receiptRef),
      refund: refund ? { id: refund.id, amountCents: refund.amountCents, diamondsTakenBack: refund.diamondsTakenBack, diamondsShort: refund.diamondsShort, hasCreditNote: refund.creditNoteStatus === 'issued' } : null,
    };
  });
}

/** Everything the owner's Club account screen shows (GET /commerce/club/dashboard). */
export async function dashboard(db: DbOrTx, clubId: string, at: Date) {
  const s = await clubState(db, clubId, at);
  const { billing } = s;
  const [club] = await db.select().from(clubs).where(eq(clubs.id, clubId));
  const current = await levelOffer(db, billing.levelCode, at);
  const pendingDowngrade = billing.pendingDowngradeCode ? await levelOffer(db, billing.pendingDowngradeCode, at) : null;
  const { limits } = await clubLimits(db, clubId, at);
  const usage = await usageOf(db, clubId, at);
  const scheduled = scheduledD(billing, s.price, at);
  const available = s.balanceD - scheduled - s.pendingD;
  const rateBp = await turnoverRateBp(db, at);
  const runwayDays = s.perDay && s.perDay > 0 ? Math.max(0, Math.floor(available / s.perDay)) : null;
  const periodStart = billing.periodStartAt ?? new Date(at.getTime() - LEVEL_PERIOD_DAYS * DAY_MS);
  const locked = club ? await isLevelLocked(db, club) : false;
  const freeClub = locked && club ? await freeClubOf(db, club.ownerId) : null;
  const start = await getBillingStart(db);
  const [messages, ledger, recentCharges, orders, requests, packs, levels, d7, d30, expiry, nextRate] = [
    await db.select().from(accountMessages).where(eq(accountMessages.clubId, clubId)).orderBy(desc(accountMessages.createdAt)).limit(MESSAGES_SHOWN),
    await ledgerPage(db, clubId),
    await chargesPage(db, clubId, RECENT_CHARGES),
    await orderList(db, clubId),
    await db.select().from(topupRequests).where(and(eq(topupRequests.clubId, clubId), eq(topupRequests.status, 'pending'))),
    await packOffers(db, at),
    await levelsTable(db, billing.levelCode, at),
    await spend(db, clubId, new Date(at.getTime() - 7 * DAY_MS)),
    await spend(db, clubId, new Date(at.getTime() - 30 * DAY_MS)),
    await nextExpiry(db, clubId, at),
    await scheduledRate(db, at),
  ];
  return {
    club: { id: clubId, name: club?.name ?? '' },
    mode: s.enforced ? 'enforced' : 'pilot',
    pilotForced: commerceConfig().pilot,
    billingStart: start && !start.applied ? { day: start.day, at: start.at } : null,
    rate: { rateBp, dPerPoint: rateBp / 100, next: nextRate ? { rateBp: nextRate.rateBp, from: nextRate.from } : null },
    state: s.state,
    diamonds: {
      balanceD: s.balanceD, availableD: available, pendingD: s.pendingD, pendingCount: s.pending.count,
      graceEndsAt: usageGraceEnds(s.pending), scheduledD: scheduled, scheduledAt: scheduled > 0 ? billing.renewsAt : null,
      runwayDays, runwayPointsCents: runwayDays !== null && rateBp > 0 ? Math.floor((available * 10_000) / rateBp) : null,
      nextExpiry: expiry,
    },
    level: {
      code: billing.levelCode, name: current?.name ?? billing.levelCode, priceD: s.price, renewsAt: billing.renewsAt,
      periodStartAt: billing.periodStartAt, levelLocked: locked, freeClubName: freeClub?.name ?? null,
      pendingDowngrade: pendingDowngrade ? { code: pendingDowngrade.code, name: pendingDowngrade.name, at: billing.renewsAt } : null,
      renewalOverdue: billing.renewalOverdueSince ? { since: billing.renewalOverdueSince, deadline: billing.renewalDeadline } : null,
    },
    limits: RESOURCES.map((r) => ({ resource: r, used: usage[r], limit: limits[r], over: limits[r] !== null && usage[r] > (limits[r] as number) })),
    levels,
    playCharge: await periodPlay(db, clubId, periodStart),
    recentCharges,
    spend: { d7, d30 },
    messages,
    unreadMessages: messages.filter((m) => !m.readAt).length,
    ledger,
    orders,
    topupRequests: requests,
    packs,
    payments: { ...cardPayments(), refundWindowDays: REFUND_WINDOW_DAYS },
    prefs: billing.prefs,
  };
}
