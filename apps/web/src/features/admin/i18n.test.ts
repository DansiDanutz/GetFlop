import { describe, expect, it } from 'vitest';
import el from '../../i18n/locales/el/admin';
import en from '../../i18n/locales/en/admin';
import { hasKey } from '../../i18n/i18n';
import { ADMIN_TABS } from './AdminShell';
import { PERIOD_PRESETS, verdictKey } from './logic';
import { REFUND_GROUNDS } from './commerce/types';

const sources = import.meta.glob<string>(['./**/*.tsx', './**/*.ts', '!./**/*.test.*'], { query: '?raw', import: 'default', eager: true });

/** Every literal t('key') in the admin sources. */
function usedKeys(): string[] {
  const keys = new Set<string>();
  for (const text of Object.values(sources)) {
    for (const m of text.matchAll(/\bt\('([a-z][a-z0-9_]+)'/g)) keys.add(m[1]!);
  }
  return [...keys];
}

describe('admin dictionaries', () => {
  it('have the same keys in English and Greek, none empty', () => {
    expect(Object.keys(el).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of [...Object.entries(en), ...Object.entries(el)]) expect({ key, empty: value.trim() === '' }).toEqual({ key, empty: false });
  });

  it('keep the same {placeholders} in both languages', () => {
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect({ key, p: params(el[key]) }).toEqual({ key, p: params(en[key]) });
  });

  it('cover every literal key the admin screens use', () => {
    expect(usedKeys().length).toBeGreaterThan(200);
    const missing = usedKeys().filter((k) => !hasKey(k) && !['a', 'code', 'connect', 'days', 'note', 'toggle', 'uses', 'value'].includes(k));
    expect(missing).toEqual([]);
  });

  it('cover the keys built from values', () => {
    const built = [
      ...ADMIN_TABS.map((tab) => tab.key),
      ...PERIOD_PRESETS.map((p) => `admin_period_${p}`),
      ...['too_few', 'more', 'less', 'as_priced'].map(verdictKey),
      ...['all', 'players', 'admins', 'inactive', 'bots'].map((f) => `admin_filter_${f}`),
      ...['player', 'admin', 'bot'].map((r) => `admin_role_${r}`),
      ...['pin', 'google'].map((s) => `admin_signin_${s}`),
      ...['hands', 'reconciliation', 'audit', 'bettypes', 'arena', 'appqr'].flatMap((k) => [`admin_more_${k}`, `admin_more_${k}_sub`]),
      ...['day', 'week', 'month', 'all'].map((p) => `admin_arena_period_${p}`),
      ...['club_level', 'diamond_pack', 'turnover_rate', 'point_rate', 'usage_rate'].map((k) => `admin_kind_${k}`),
      ...['draft', 'active', 'archived'].map((l) => `admin_lifecycle_${l}`),
      ...['catalogue', 'payments', 'codes', 'audit'].map((x) => `admin_commerce_tab_${x}`),
      ...REFUND_GROUNDS.map((g) => `admin_refund_ground_${g}`),
      ...['create_user', 'update_user', 'deactivate_user', 'activate_user', 'reset_pin', 'void_bet', 'bet_type_update'].map((a) => `audit_action_${a}`),
      ...['admin_price_level', 'admin_price_pack', 'admin_price_rate', 'admin_price_other'],
    ];
    expect(built.filter((k) => !hasKey(k))).toEqual([]);
  });

  it('translate every admin error code the server sends', () => {
    const codes = ['create_missing', 'name_length', 'pin_digits', 'role_invalid', 'self_deactivate', 'user_not_found', 'username_taken',
      'bet_not_found', 'bet_not_settled', 'bet_already_voided', 'bet_unit_unsupported', 'reason_required', 'hand_not_found',
      'bet_type_not_found', 'payout_invalid', 'probability_invalid', 'section_not_found'];
    expect(codes.map((c) => `err_admin_${c}`).filter((k) => !hasKey(k))).toEqual([]);
  });
});
