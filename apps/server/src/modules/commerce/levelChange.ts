import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx, Tx } from '../../db/client.js';
import { clubs, commerceCharges, commerceVersions, type LevelLimitsJson } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { ClubAccess } from '../clubs/access.js';
import { getBilling, isEnforced, updateBilling, type BillingRow } from './billing.js';
import { levelOffer, type LevelOffer } from './catalogue.js';
import { addDays, commerceConfig, DAY_MS, LEVEL_PERIOD_DAYS } from './config.js';
import { freeClubOf, usageOf, type Resource } from './limits.js';
import { accountMessage, audit } from './notify.js';
import { balanceOf, debit } from './wallet.js';

export type Direction = 'upgrade' | 'downgrade' | 'same';

export interface Blocker {
  readonly resource: Resource;
  readonly used: number;
  readonly newLimit: number;
}

export interface LevelQuote {
  readonly productId: string;
  readonly code: string;
  readonly name: string;
  readonly direction: Direction;
  readonly priceD: number;
  /** What the upgrade costs now: new price minus the unused part of the current period. */
  readonly proratedD: number;
  readonly creditD: number;
  readonly remainingDays: number;
  /** Upgrade: the new renewal date. Downgrade: the date it takes effect. */
  readonly renewalDate: string | null;
  readonly newLimits: LevelLimitsJson;
  readonly balanceD: number;
  /** False in the pilot: nothing is charged ("the price would be X D"). */
  readonly charged: boolean;
  readonly blockers: readonly Blocker[];
}

/** Price the club paid for its current period (its version), not today's catalogue price. */
async function paidPrice(db: DbOrTx, billing: BillingRow): Promise<number> {
  if (!billing.levelVersionId) return 0;
  const [v] = await db.select({ price: commerceVersions.priceDiamonds }).from(commerceVersions)
    .where(eq(commerceVersions.id, billing.levelVersionId));
  return v?.price ?? 0;
}

export function remainingDays(billing: BillingRow, at: Date): number {
  if (!billing.renewsAt) return 0;
  const days = Math.ceil((billing.renewsAt.getTime() - at.getTime()) / DAY_MS);
  return Math.min(LEVEL_PERIOD_DAYS, Math.max(0, days));
}

/**
 * Proration: the unused part of the current period is credited against the full new price and a
 * fresh 30-day period starts now (so the renewal date moves). creditD = floor(paid × remaining / 30).
 */
export function prorate(newPriceD: number, paidPriceD: number, daysLeft: number): { proratedD: number; creditD: number } {
  const creditD = Math.floor((paidPriceD * daysLeft) / LEVEL_PERIOD_DAYS);
  return { proratedD: Math.max(0, newPriceD - creditD), creditD };
}

async function overLimits(db: DbOrTx, clubId: string, limits: LevelLimitsJson, at: Date): Promise<Blocker[]> {
  const usage = await usageOf(db, clubId, at);
  const checked: Resource[] = ['members', 'ringGames', 'tournaments', 'rooms'];
  return checked
    .filter((r) => limits[r] !== null && usage[r] > (limits[r] as number))
    .map((r) => ({ resource: r, used: usage[r], newLimit: limits[r] as number }));
}

async function target(db: DbOrTx, productId: string, at: Date): Promise<LevelOffer> {
  const offer = await levelOffer(db, productId, at);
  if (!offer) throw new AppError('commerce.catalogue_missing', 404);
  if (!offer.onSale) throw new AppError('commerce.level_not_on_sale', 409);
  return offer;
}

export async function quoteLevel(db: DbOrTx, clubId: string, productId: string, at: Date): Promise<LevelQuote> {
  const billing = await getBilling(db, clubId, at);
  const offer = await target(db, productId, at);
  const current = await levelOffer(db, billing.levelCode, at);
  const currentRank = current?.rank ?? 0;
  const direction: Direction = offer.rank > currentRank ? 'upgrade' : offer.rank < currentRank ? 'downgrade' : 'same';
  const daysLeft = remainingDays(billing, at);
  const { proratedD, creditD } = prorate(offer.priceD, await paidPrice(db, billing), daysLeft);
  const renewalDate = direction === 'upgrade' ? addDays(at, LEVEL_PERIOD_DAYS) : billing.renewsAt;
  return {
    productId: offer.productId, code: offer.code, name: offer.name, direction, priceD: offer.priceD,
    proratedD: direction === 'upgrade' ? proratedD : 0, creditD: direction === 'upgrade' ? creditD : 0, remainingDays: daysLeft,
    renewalDate: renewalDate?.toISOString() ?? null, newLimits: offer.limits, balanceD: await balanceOf(db, clubId),
    charged: isEnforced(billing), blockers: direction === 'downgrade' ? await overLimits(db, clubId, offer.limits, at) : [],
  };
}

/** Moves the club onto a Level for a new period (mirrors clubs.level for the capacity checks). */
async function setLevel(tx: DbOrTx, clubId: string, offer: LevelOffer, start: Date, at: Date): Promise<BillingRow> {
  const free = offer.priceD === 0 && offer.code === 'starter';
  const renewsAt = free ? null : addDays(start, LEVEL_PERIOD_DAYS);
  await tx.update(clubs).set({ level: offer.code, levelRenewsAt: renewsAt }).where(eq(clubs.id, clubId));
  return updateBilling(tx, clubId, {
    levelCode: offer.code, levelVersionId: offer.versionId, periodStartAt: start, renewsAt,
    pendingDowngradeCode: null, renewalOverdueSince: null, renewalDeadline: null, pausedNotifiedAt: null,
  }, at);
}

/** Records a Level charge: taken from the wallet when enforced, a preview row in the pilot. */
async function chargeLevel(ctx: AppContext, tx: Tx, billing: BillingRow, offer: LevelOffer, amount: number, reason: 'upgrade' | 'renewal', actorId: string | null): Promise<void> {
  const at = ctx.now();
  const enforced = isEnforced(billing);
  if (enforced && amount > 0) {
    await debit(tx, {
      clubId: billing.clubId, type: 'level_charge', amount, at, actorId, refType: 'level', refId: offer.versionId,
      data: { level: offer.code, reason },
    });
  }
  await tx.insert(commerceCharges).values({
    clubId: billing.clubId, kind: 'level', status: enforced ? 'charged' : 'preview', diamonds: amount,
    label: offer.name, data: { level: offer.code, reason, versionId: offer.versionId }, createdAt: at,
  });
}

export async function upgradeLevel(ctx: AppContext, tx: Tx, access: ClubAccess, productId: string) {
  const at = ctx.now();
  const clubId = access.club.id;
  const quote = await quoteLevel(tx, clubId, productId, at);
  if (quote.direction !== 'upgrade') throw new AppError('commerce.level_not_an_upgrade', 409);
  const billing = await getBilling(tx, clubId, at);
  const offer = (await levelOffer(tx, quote.code, at))!;
  await chargeLevel(ctx, tx, billing, offer, quote.proratedD, 'upgrade', access.user.id);
  const updated = await setLevel(tx, clubId, offer, at, at);
  await accountMessage(ctx, tx, clubId, 'level_upgraded', {
    level: offer.name, costD: quote.proratedD, renewsAt: updated.renewsAt?.toISOString() ?? '',
  });
  await audit(ctx, tx, access.user.id, 'level_upgrade', { type: 'club', id: clubId }, { level: offer.code, costD: quote.proratedD, charged: quote.charged });
  return { level: offer.code, name: offer.name, chargedD: quote.charged ? quote.proratedD : 0, previewD: quote.proratedD, renewsAt: updated.renewsAt, limits: offer.limits };
}

/** Moving to Starter while the owner already holds a free club is refused. */
async function assertFreeSlot(db: DbOrTx, access: ClubAccess): Promise<void> {
  const free = await freeClubOf(db, access.club.ownerId);
  if (!free || free.id === access.club.id) return;
  const isOwner = access.club.ownerId === access.user.id;
  throw new AppError(isOwner ? 'commerce.level_free_club_held' : 'commerce.level_free_club_held_owner', 409, { freeClub: free.name });
}

export async function scheduleDowngrade(ctx: AppContext, tx: Tx, access: ClubAccess, productId: string) {
  const at = ctx.now();
  const quote = await quoteLevel(tx, access.club.id, productId, at);
  if (quote.direction !== 'downgrade') throw new AppError('commerce.level_not_a_downgrade', 409);
  if (quote.code === 'starter') await assertFreeSlot(tx, access);
  await updateBilling(tx, access.club.id, { pendingDowngradeCode: quote.code }, at);
  await audit(ctx, tx, access.user.id, 'level_downgrade_scheduled', { type: 'club', id: access.club.id }, { level: quote.code });
  return { pendingDowngrade: { code: quote.code, name: quote.name, at: quote.renewalDate }, blockers: quote.blockers };
}

export async function cancelDowngrade(ctx: AppContext, tx: Tx, access: ClubAccess) {
  await updateBilling(tx, access.club.id, { pendingDowngradeCode: null }, ctx.now());
  await audit(ctx, tx, access.user.id, 'level_downgrade_cancelled', { type: 'club', id: access.club.id });
  return { pendingDowngrade: null };
}

/** The Level the club moves to at renewal: its pending downgrade unless usage or the free-club rule blocks it. */
async function renewalTarget(ctx: AppContext, tx: Tx, billing: BillingRow, at: Date): Promise<LevelOffer> {
  const current = (await levelOffer(tx, billing.levelCode, at))!;
  if (!billing.pendingDowngradeCode) return current;
  const next = await levelOffer(tx, billing.pendingDowngradeCode, at);
  if (!next) return current;
  const [blocker] = await overLimits(tx, billing.clubId, next.limits, at);
  if (blocker) {
    await accountMessage(ctx, tx, billing.clubId, 'level_downgrade_blocked', { ...blocker, level: next.name });
    return current;
  }
  if (next.code === 'starter') {
    const [club] = await tx.select().from(clubs).where(eq(clubs.id, billing.clubId));
    const free = club ? await freeClubOf(tx, club.ownerId) : null;
    if (free && free.id !== billing.clubId) {
      await accountMessage(ctx, tx, billing.clubId, 'level_downgrade_free_club_held', { freeClub: free.name });
      return current;
    }
  }
  return next;
}

/**
 * Renews one club whose period ended. Enforced clubs pay the Level price in force now; if the wallet
 * cannot cover it the renewal is overdue with a deadline (then the club pauses). Pilot clubs renew as a preview.
 */
export async function renewClub(ctx: AppContext, tx: Tx, billing: BillingRow): Promise<'renewed' | 'overdue' | 'downgraded'> {
  const at = ctx.now();
  const offer = await renewalTarget(ctx, tx, billing, at);
  const start = billing.renewalOverdueSince ? at : billing.renewsAt ?? at;
  if (offer.priceD === 0) {
    await setLevel(tx, billing.clubId, offer, at, at);
    await accountMessage(ctx, tx, billing.clubId, 'level_changed', { level: offer.name });
    return 'downgraded';
  }
  const balance = await balanceOf(tx, billing.clubId);
  if (isEnforced(billing) && balance < offer.priceD) {
    if (!billing.renewalOverdueSince) {
      const deadline = addDays(at, commerceConfig().renewalGraceDays);
      await updateBilling(tx, billing.clubId, { renewalOverdueSince: at, renewalDeadline: deadline }, at);
      await accountMessage(ctx, tx, billing.clubId, 'renewal_overdue', {
        level: offer.name, costD: offer.priceD, shortfallD: offer.priceD - balance, deadline: deadline.toISOString(),
      });
    }
    return 'overdue';
  }
  await chargeLevel(ctx, tx, billing, offer, offer.priceD, 'renewal', null);
  const updated = await setLevel(tx, billing.clubId, offer, start, at);
  await accountMessage(ctx, tx, billing.clubId, offer.code === billing.levelCode ? 'level_renewed' : 'level_changed', {
    level: offer.name, costD: offer.priceD, renewsAt: updated.renewsAt?.toISOString() ?? '', preview: isEnforced(billing) ? 0 : 1,
  });
  return offer.code === billing.levelCode ? 'renewed' : 'downgraded';
}

