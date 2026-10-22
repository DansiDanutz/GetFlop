/**
 * Player-facing labels for ledger movements (spec 04 §7). The web translates
 * `history_kind_<label>`. Kinds not listed are not shown to players
 * (e.g. `bet_settled` moves a stake from "riding" to the pool, not the wallet).
 */
export const PLAYER_LABELS: Readonly<Record<string, string>> = {
  deposit: 'points_received',
  reload: 'request_approved',
  withdrawal: 'claim_back',
  cashout: 'points_returned',
  coupon_placed: 'coupon',
  bet_won: 'win',
  bet_refunded: 'points_refunded',
  coupon_voided: 'coupon_voided',
  coupon_leg_cancelled: 'leg_cancelled',
  membership_ended: 'membership_ended',
  tournament_buyin: 'tournament_buyin',
  tournament_rebuy: 'tournament_rebuy',
  tournament_addon: 'tournament_addon',
  tournament_refund: 'tournament_refund',
  tournament_payout: 'tournament_payout',
  sim_reset: 'sim_reset',
};

/** Ledger kinds that belong to play (used for the "net today" figure). */
export const GAME_KINDS: ReadonlySet<string> = new Set([
  'coupon_placed', 'bet_won', 'bet_refunded', 'coupon_voided', 'coupon_leg_cancelled',
]);

export function playerLabel(kind: string): string {
  return PLAYER_LABELS[kind] ?? 'other';
}

/** Signed change of the player's wallet for one movement: + into the wallet, − out of it. */
export function walletDelta(
  row: { amountCents: number; fromAccountId: string | null; toAccountId: string | null },
  walletIds: ReadonlySet<string>,
): number {
  if (row.toAccountId && walletIds.has(row.toAccountId)) return row.amountCents;
  if (row.fromAccountId && walletIds.has(row.fromAccountId)) return -row.amountCents;
  return 0;
}
