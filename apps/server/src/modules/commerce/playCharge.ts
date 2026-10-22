import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { Tx } from '../../db/client.js';
import { commerceCharges } from '../../db/schema/index.js';
import type { SettledInfo } from '../game/hooks.js';
import { getBilling, isEnforced, pendingCharges, pendingSummary, updateBilling } from './billing.js';
import { turnoverRateBp } from './catalogue.js';
import { renewClub } from './levelChange.js';
import { accountMessage } from './notify.js';
import { balanceOf, credit, debit } from './wallet.js';

/** 100 = 1% of a Point rated at 100 D = 1 D per Point; Points are in cents (100 = 1 PT). */
const BP_SCALE = 10_000;

/** Diamonds for `pointsCents` played at `rateBp`, rounded half up. */
export function playChargeD(pointsCents: number, rateBp: number): number {
  return Math.round((pointsCents * rateBp) / BP_SCALE);
}

type ChargeKind = 'hand' | 'tournament_entry';

interface ChargeInput {
  readonly clubId: string;
  readonly kind: ChargeKind;
  readonly pointsCents: number;
  readonly label: string;
  readonly handId?: string;
  readonly tableId?: string;
  readonly tournamentId?: string;
  readonly userId?: string;
}

/**
 * Records one play charge. Pilot: a preview row (measured, not charged). Enforced: taken from the wallet,
 * or recorded as pending when the wallet cannot cover it or older charges are still unpaid.
 */
async function recordPlayCharge(ctx: AppContext, tx: Tx, input: ChargeInput): Promise<void> {
  const at = ctx.now();
  const diamonds = playChargeD(input.pointsCents, await turnoverRateBp(tx, at));
  const billing = await getBilling(tx, input.clubId, at);
  let status = 'preview';
  if (isEnforced(billing) && diamonds > 0) {
    const hasUnpaid = (await pendingSummary(tx, input.clubId)).count > 0;
    status = !hasUnpaid && (await balanceOf(tx, input.clubId)) >= diamonds ? 'charged' : 'pending';
  } else if (isEnforced(billing)) {
    status = 'charged';
  }
  const [row] = await tx.insert(commerceCharges).values({
    clubId: input.clubId, kind: input.kind, status, diamonds, pointsCents: input.pointsCents,
    handId: input.handId ?? null, tableId: input.tableId ?? null, tournamentId: input.tournamentId ?? null,
    userId: input.userId ?? null, label: input.label, createdAt: at,
  }).onConflictDoNothing().returning();
  if (row && status === 'charged' && diamonds > 0) {
    await debit(tx, {
      clubId: input.clubId, type: 'usage_charge', amount: diamonds, at, refType: input.kind, refId: row.id,
      data: { pointsCents: input.pointsCents, label: input.label },
    });
  }
  if (row && status === 'pending' && (await pendingSummary(tx, input.clubId)).count === 1) {
    await accountMessage(ctx, tx, input.clubId, 'charges_pending', { pendingD: diamonds });
  }
}

/** Settled-hand hook: 1 D per Point played on Ring Game picks. Tournament chips and Arena Stars never count. */
export async function chargeSettledHand(ctx: AppContext, tx: Tx, info: SettledInfo): Promise<void> {
  if (info.table.kind !== 'cash') return;
  const played = info.bets
    .filter((b) => b.status === 'won' || b.status === 'lost')
    .reduce((sum, b) => sum + b.stakeCents, 0);
  if (played <= 0) return;
  await recordPlayCharge(ctx, tx, {
    clubId: info.table.clubId, kind: 'hand', pointsCents: played, handId: info.hand.id, tableId: info.table.id,
    label: `${info.hand.handNumber}·${info.table.name}`,
  });
}

export interface TournamentEntryCharge {
  readonly clubId: string;
  readonly tournamentId: string;
  readonly tournamentName: string;
  readonly userId: string;
  readonly playerName: string;
  /** The buy-in in Points (cents): only the buy-in counts, never the chips. */
  readonly buyInCents: number;
}

/** For the tournaments module: charge a registration's buy-in (call inside its transaction). */
export async function chargeTournamentEntry(ctx: AppContext, tx: Tx, e: TournamentEntryCharge): Promise<void> {
  if (e.buyInCents <= 0) return;
  await recordPlayCharge(ctx, tx, {
    clubId: e.clubId, kind: 'tournament_entry', pointsCents: e.buyInCents, tournamentId: e.tournamentId, userId: e.userId,
    label: `${e.tournamentName}·${e.playerName}`,
  });
}

/** For the tournaments module: an unregister or cancel gives the entry charge back ("Entry given back"). */
export async function refundTournamentEntry(ctx: AppContext, tx: Tx, e: TournamentEntryCharge): Promise<void> {
  const at = ctx.now();
  const [original] = await tx.select().from(commerceCharges).where(and(
    eq(commerceCharges.clubId, e.clubId), eq(commerceCharges.kind, 'tournament_entry'),
    eq(commerceCharges.tournamentId, e.tournamentId), eq(commerceCharges.userId, e.userId),
  )).orderBy(commerceCharges.createdAt).limit(1);
  if (!original || original.data?.refunded) return;
  await tx.update(commerceCharges).set({ data: { ...(original.data ?? {}), refunded: true } }).where(eq(commerceCharges.id, original.id));
  const status = original.status === 'charged' || original.status === 'settled' ? 'charged'
    : original.status === 'pending' ? 'cancelled' : 'preview';
  if (original.status === 'pending') {
    await tx.update(commerceCharges).set({ status: 'cancelled' }).where(eq(commerceCharges.id, original.id));
  }
  const [row] = await tx.insert(commerceCharges).values({
    clubId: e.clubId, kind: 'entry_refund', status, diamonds: -original.diamonds, pointsCents: -original.pointsCents,
    tournamentId: e.tournamentId, userId: e.userId, label: `${e.tournamentName}·${e.playerName}`, createdAt: at,
  }).returning();
  if (status === 'charged' && original.diamonds > 0) {
    await credit(tx, {
      clubId: e.clubId, type: 'usage_refund', amount: original.diamonds, source: 'usage_refund', at,
      refType: 'charge', refId: row!.id, data: { tournamentId: e.tournamentId },
    });
  }
}

/**
 * After Diamonds arrive: pay unpaid play charges oldest first (ledger charge_settlement),
 * then an overdue renewal. Returns how many charges were settled.
 */
export async function settleOutstanding(ctx: AppContext, tx: Tx, clubId: string): Promise<number> {
  const at = ctx.now();
  const pending = await pendingCharges(tx, clubId);
  let settled = 0;
  let paidD = 0;
  for (const charge of pending) {
    if ((await balanceOf(tx, clubId)) < charge.diamonds) break;
    await debit(tx, {
      clubId, type: 'charge_settlement', amount: charge.diamonds, at, refType: 'charge', refId: charge.id,
      data: { label: charge.label, pointsCents: charge.pointsCents },
    });
    await tx.update(commerceCharges).set({ status: 'settled', settledAt: at }).where(eq(commerceCharges.id, charge.id));
    settled += 1;
    paidD += charge.diamonds;
  }
  const billing = await getBilling(tx, clubId, at);
  if (billing.renewalOverdueSince) {
    await renewClub(ctx, tx, billing);
  }
  const after = await getBilling(tx, clubId, at);
  const stillPending = (await pendingSummary(tx, clubId)).count > 0;
  if (settled > 0 && !stillPending && !after.renewalOverdueSince) {
    await accountMessage(ctx, tx, clubId, 'play_available', { paidD });
    if (after.pausedNotifiedAt) await updateBilling(tx, clubId, { pausedNotifiedAt: null }, at);
  }
  return settled;
}
