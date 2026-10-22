import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/i18n';
import { dockMode, isLive, tableBadgeKey, type Hand } from './api';
import { noticeKey } from './DealerShell';
import { tableJoinLink } from './QrSheets';
import { handOutcome } from './RecentHands';
import { scaledSize, scanMessage } from './scanImage';

const hand = (over: Partial<Hand> = {}): Hand => ({
  id: 'h', handNumber: 3, status: 'settled', flop: ['Ah', 'Kd', '2c'], totalBets: 4, winningBets: 1,
  totalWageredCents: 800, totalPaidOutCents: 460, bettingClosesAt: null, dealtBy: 'dealer', createdAt: '', settledAt: null, ...over,
});

describe('console helpers', () => {
  it('picks the dock buttons from the hand state', () => {
    expect(dockMode({ isAutoDeal: false }, null)).toBe('new');
    expect(dockMode({ isAutoDeal: false }, hand())).toBe('new');
    expect(dockMode({ isAutoDeal: true }, null)).toBe('auto');
    expect(dockMode({ isAutoDeal: false }, hand({ status: 'betting_open' }))).toBe('open');
    expect(dockMode({ isAutoDeal: false }, hand({ status: 'betting_closed' }))).toBe('closed');
    expect(isLive(hand({ status: 'cancelled' }))).toBe(false);
  });

  it('labels a table on the list', () => {
    expect(tableBadgeKey({ status: 'closed', currentHand: null })).toBe('dealer_badge_closed');
    expect(tableBadgeKey({ status: 'open', currentHand: null })).toBe('dealer_badge_open');
    expect(tableBadgeKey({ status: 'open', currentHand: hand({ status: 'betting_open' }) })).toBe('dealer_badge_picks_open');
    expect(tableBadgeKey({ status: 'open', currentHand: hand({ status: 'betting_closed' }) })).toBe('dealer_badge_dealing');
  });

  it('describes a hand result, in TC for tournaments', () => {
    expect(handOutcome(hand(), 'points', t)).toBe('won 4.60 PTS');
    expect(handOutcome(hand({ winningBets: 0, totalPaidOutCents: 0 }), 'points', t)).toBe('no winners');
    expect(handOutcome(hand({ status: 'cancelled' }), 'points', t)).toBe('cancelled');
    expect(handOutcome(hand({ status: 'betting_open' }), 'points', t)).toBe('in play');
    expect(handOutcome(hand(), 'chips', t)).toBe('won 4.60 TC');
  });

  it('builds notice keys and join links', () => {
    expect(noticeKey('dealer.wanted_elsewhere')).toBe('notice_dealer_wanted_elsewhere');
    expect(t(noticeKey('dealer.wanted_elsewhere'), { wantedBy: 'Floor', table: 'T1', club: 'Sharks' }))
      .toBe('Floor wants you to deal, but you are still seated at T1 (Sharks). Stand up there first.');
    expect(tableJoinLink('AB12CD34', 'https://app.getflop.test')).toBe('https://app.getflop.test/#/join/AB12CD34');
  });
});

describe('scan helpers', () => {
  it('downscales so the longest side is at most 1568 px', () => {
    expect(scaledSize(4032, 3024)).toEqual({ width: 1568, height: 1176 });
    expect(scaledSize(1080, 1920)).toEqual({ width: 882, height: 1568 });
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('chooses the message from the cards and the confidence', () => {
    expect(scanMessage({ cards: ['Ah', 'Kd', '2c'], confidence: 'high' }).key).toBe('dealer_scan_ok');
    expect(scanMessage({ cards: ['Ah', 'Kd', '2c'], confidence: 'low' }).key).toBe('dealer_scan_doubt');
    expect(scanMessage({ cards: ['Ah'], confidence: 'high' })).toEqual({ key: 'dealer_scan_partial', params: { n: 1 } });
  });
});
