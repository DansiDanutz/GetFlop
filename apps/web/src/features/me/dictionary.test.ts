import { describe, expect, it } from 'vitest';
import el from '../../i18n/locales/el/me';
import en from '../../i18n/locales/en/me';
import { WELCOME_CARDS } from './Welcome';

/** Keys built at runtime from server values; each must exist in both languages. */
const DYNAMIC: readonly string[] = [
  ...['live', 'completed', 'voided'].map((s) => `me_coupon_status_${s}`),
  ...['betting_open', 'betting_closed', 'settled', 'cancelled'].map((s) => `me_draw_status_${s}`),
  ...['pending', 'lost', 'refunded', 'voided', 'won'].map((s) => `me_pick_status_${s}`),
  ...['picks_open', 'picks_closed', 'waiting', 'table_closed'].map((s) => `me_game_state_${s}`),
  ...['points', 'coupon', 'cancel', 'join', 'pin', 'device'].flatMap((k) => [`me_faq_${k}_q`, `me_faq_${k}_a`]),
  ...['invite', 'member', 'pending', 'invalid', 'sent'].map((v) => `me_invite_${v}`),
  ...['invalid', 'closed', 'signin', 'member', 'pending', 'request', 'sent'].map((v) => `me_join_${v}`),
  // Labels from the server's modules/me/labels.ts (PLAYER_LABELS values + 'other').
  ...['points_received', 'request_approved', 'claim_back', 'points_returned', 'coupon', 'win', 'points_refunded', 'coupon_voided',
    'leg_cancelled', 'membership_ended', 'tournament_buyin', 'tournament_rebuy', 'tournament_addon', 'tournament_refund',
    'tournament_payout', 'sim_reset', 'other'].map((l) => `me_kind_${l}`),
  ...['empty', 'invalid', 'over_balance', 'nothing_to_return'].map((e) => `me_points_error_${e}`),
  ...['request', 'return'].flatMap((s) => [`me_receipt_${s}_approved`, `me_receipt_${s}_declined`]),
  ...['pending', 'approved', 'rejected'].map((s) => `me_request_status_${s}`),
  ...WELCOME_CARDS.flatMap((c) => [`me_welcome_${c.key}_title`, `me_welcome_${c.key}_body`]),
  ...['android', 'iphone', 'ipad', 'windows', 'mac', 'linux', 'other'].map((d) => `me_device_${d}`),
  ...['1', '2', '3'].map((n) => `me_install_ios_${n}`),
  ...['account_last_owner', 'account_pin_wrong', 'account_platform_admin', 'auth_google_disabled', 'auth_google_invalid',
    'auth_google_expired', 'auth_google_already_linked', 'auth_google_linked_elsewhere', 'auth_session_ended', 'session_expired',
    'club_leave_live_coupons', 'club_leave_dealing', 'club_leave_tournament'].map((c) => `err_${c}`),
];

describe('me dictionaries', () => {
  it.each(DYNAMIC)('has %s in English and Greek', (key) => {
    expect(en[key], `en ${key}`).toBeTruthy();
    expect(el[key], `el ${key}`).toBeTruthy();
  });

  it('never ships the other product\'s name', () => {
    const all = [...Object.values(en), ...Object.values(el)].join('\n');
    expect(all).not.toMatch(/flop\s?me/i);
  });
});
