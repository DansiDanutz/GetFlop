import { MARKETS } from '@getflop/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import el from '../../i18n/locales/el/player';
import en from '../../i18n/locales/en/player';
import { numberDraws } from './CouponDrawsSheet';
import { acknowledgeLock, hasAcknowledgedLock, queuePlayAgain, takePlayAgain } from './data';
import { lobbyStatus } from './Lobby';
import { FILTER_TABS, marketKey, RULE_GROUPS } from './markets';
import type { Draw, HandSettledEvent, PublicHand } from './types';
import { myWinFrom } from './useTableLive';

describe('player dictionaries', () => {
  it('has the same keys in English and Greek, none empty', () => {
    expect(Object.keys(el).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(el)) expect(value.trim(), key).not.toBe('');
  });

  it('names every market and covers every dynamic key the screens build', () => {
    const dynamic = [
      ...MARKETS.map((m) => marketKey(m.slug)),
      ...FILTER_TABS.map((f) => `player_tab_${f}`),
      ...RULE_GROUPS.map((g) => `player_rules_group_${g.key}`),
      ...['staff', 'watch', 'dealer'].map((r) => `player_block_${r}`),
      ...['reconnecting', 'disconnected'].map((c) => `player_conn_${c}`),
      ...['live', 'completed', 'voided'].map((s) => `player_coupon_status_${s}`),
      ...['nlh', 'plo', 'other'].flatMap((g) => [`player_game_${g}`, `player_game_short_${g}`]),
      ...['open', 'dealing', 'waiting', 'no_dealer'].map((s) => `player_lobby_status_${s}`),
      ...['pending', 'won', 'lost', 'refunded', 'voided'].map((s) => `player_pick_${s}`),
      ...['amount', 'locked', 'fixed', 'cancelled', 'closed', 'tournament'].map((k) => `player_rules_coupon_${k}`),
      ...['bar', 'band', 'numbers', 'predict', 'hands'].flatMap((k) => [`player_heat_help_${k}_q`, `player_heat_help_${k}_a`]),
    ];
    for (const key of dynamic) expect(en, key).toHaveProperty(key);
  });

  it('defines every literal key used in the player sources', () => {
    const sources = import.meta.glob<string>(['./*.tsx', './*.ts', '!./*.test.ts'], { query: '?raw', import: 'default', eager: true });
    const used = new Set(Object.values(sources).flatMap((src) => [...src.matchAll(/'(player_[a-z0-9_]+)'/g)].map((m) => m[1]!)));
    expect(used.size).toBeGreaterThan(50);
    for (const key of used) expect(en, key).toHaveProperty(key);
  });
});

/** In-memory Web Storage (the test runtime does not always provide one). */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => { data.delete(k); },
    setItem: (k, v) => { data.set(k, String(v)); },
  };
}

describe('play-again hand-off', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('queues a coupon once and clears it when taken', () => {
    queuePlayAgain({ picks: [{ market: 'rainbow', stakeCents: 200 }], rounds: 5 });
    expect(takePlayAgain()).toEqual({ picks: [{ market: 'rainbow', stakeCents: 200 }], rounds: 5 });
    expect(takePlayAgain()).toBeNull();
  });

  it('ignores malformed storage', () => {
    sessionStorage.setItem('getflop_play_again', '{not json');
    expect(takePlayAgain()).toBeNull();
    sessionStorage.setItem('getflop_play_again', JSON.stringify({ picks: [{ market: 1 }, { market: 'any-pair', stakeCents: 100 }], rounds: 2 }));
    expect(takePlayAgain()).toEqual({ picks: [{ market: 'any-pair', stakeCents: 100 }], rounds: 2 });
  });

  it('remembers the locked-coupon acknowledgement per device', () => {
    expect(hasAcknowledgedLock()).toBe(false);
    acknowledgeLock();
    expect(hasAcknowledgedLock()).toBe(true);
  });
});

describe('numberDraws', () => {
  it('numbers only the flops actually used', () => {
    const draw = (handNumber: number, status: Draw['status']): Draw => ({ handNumber, status, flop: null, picks: [] });
    expect(numberDraws([draw(1, 'settled'), draw(2, 'cancelled'), draw(3, 'betting_open')]).map((d) => d.flopNumber)).toEqual([1, null, 2]);
  });
});

describe('myWinFrom', () => {
  const bet = (userId: string, slug: string, amountCents: number, payoutCents: number) =>
    ({ betId: `${userId}${slug}`, userId, username: userId, betTypeSlug: slug, amountCents, payoutCents, couponId: 'c' });
  const event: HandSettledEvent = {
    tableId: 't', handId: 'h1', handNumber: 4, card1: 'Qc', card2: '7h', card3: '3s', matchingSlugs: ['rainbow'], isTournament: false,
    winners: [bet('me', 'rainbow', 200, 460), bet('other', 'rainbow', 100, 230)],
    losers: [bet('me', 'any-pair', 100, 0)],
  };

  it('sums my payouts and nets out everything I had on the hand', () => {
    expect(myWinFrom(event, 'me')).toEqual({
      handId: 'h1', cards: ['Qc', '7h', '3s'], payoutCents: 460, netCents: 160,
      picks: [{ market: 'rainbow', stakeCents: 200, payoutCents: 460 }],
    });
  });

  it('is null when I did not win or am unknown', () => {
    expect(myWinFrom({ ...event, winners: [] }, 'me')).toBeNull();
    expect(myWinFrom(event, undefined)).toBeNull();
  });
});

describe('lobbyStatus', () => {
  const hand = (status: PublicHand['status']) => ({ status } as PublicHand);
  it('reads picks open, dealing, waiting and no dealer', () => {
    expect(lobbyStatus({ currentHand: hand('betting_open'), dealerId: 'd', isAutoDeal: false })).toBe('open');
    expect(lobbyStatus({ currentHand: hand('betting_closed'), dealerId: 'd', isAutoDeal: false })).toBe('dealing');
    expect(lobbyStatus({ currentHand: null, dealerId: 'd', isAutoDeal: false })).toBe('waiting');
    expect(lobbyStatus({ currentHand: null, dealerId: null, isAutoDeal: false })).toBe('no_dealer');
    expect(lobbyStatus({ currentHand: null, dealerId: null, isAutoDeal: true })).toBe('waiting');
  });
});
