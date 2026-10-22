import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { grantRole } from '../../test/fixtures.js';
import { coupon, openFloor, playHand, syncClock, type Floor } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv({ bettingTimerSeconds: 0 }); });
afterEach(async () => { await env.close(); });

/**
 * Hand 1 (Qc 7h 3s): Alice Rainbow 2 → wins 4.60; Bob Any Pair 1 → lost.
 * Hand 2 (7h 7d 2h): Alice Contains an Ace 3 → lost; Bob Any Pair 1 → wins 5.
 * Handle 7.00, paid 9.60, club result −2.60.
 */
async function evening(): Promise<Floor & { hand1: { id: string }; hand2: { id: string } }> {
  syncClock(env);
  const f = await openFloor(env);
  const hand1 = await playHand(f, ['Qc', '7h', '3s'], async () => {
    ok(await f.alice.post('/api/player/coupon').send(coupon(f.tableId, 'rainbow', 200)));
    ok(await f.bob.post('/api/player/coupon').send(coupon(f.tableId, 'any-pair', 100)));
  });
  const hand2 = await playHand(f, ['7h', '7d', '2h'], async () => {
    ok(await f.alice.post('/api/player/coupon').send(coupon(f.tableId, 'has-ace', 300)));
    ok(await f.bob.post('/api/player/coupon').send(coupon(f.tableId, 'any-pair', 100)));
  });
  return { ...f, hand1, hand2 };
}

describe('hands list and detail', () => {
  it('lists settled hands newest first with played, paid and hold', async () => {
    const f = await evening();
    const { hands, truncated } = ok(await f.owner.get(`/api/inspector/results?tableId=${f.tableId}`));
    expect(truncated).toBe(false);
    expect(hands.map((h: { handNumber: number }) => h.handNumber)).toEqual([2, 1]);
    expect(hands[1]).toMatchObject({ flop: ['Qc', '7h', '3s'], bets: 2, winningBets: 1, playedCents: 300, paidCents: 460, holdCents: -160, kind: 'cash' });
  });

  it('exports the hands as CSV with the spec columns', async () => {
    const f = await evening();
    const res = await f.owner.get('/api/inspector/results?format=csv');
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Hand,Table,Kind,Card1,Card2,Card3,Bets,Winning bets,Played PTS,Won by players PTS,Club result PTS,Played TC,Won by players TC,Date');
    expect(lines[2]).toMatch(/^1,Main,cash,Qc,7h,3s,2,1,3\.00,4\.60,-1\.60,,,20\d\d-/);
  });

  it('shows every pick of a hand by player', async () => {
    const f = await evening();
    const d = ok(await f.owner.get(`/api/inspector/hands/${f.hand1.id}`));
    expect(d.dealtBy).toEqual({ kind: 'dealer', name: 'dealer' });
    expect(d.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'alice', playedCents: 200, wonCents: 460, picks: [expect.objectContaining({ market: 'rainbow', status: 'won', payoutCents: 460 })] }),
      expect.objectContaining({ name: 'bob', playedCents: 100, wonCents: 0, picks: [expect.objectContaining({ market: 'any-pair', status: 'lost' })] }),
    ]));
    expect(errCode(await f.owner.get('/api/inspector/hands/nope'))).toBe('hand.not_found');
  });
});

describe('summary and shift report', () => {
  it('computes KPIs, per market, per table (idle included) and per player', async () => {
    const f = await evening();
    ok(await f.owner.post('/api/inspector/table').send({ name: 'Idle' }));
    const s = ok(await f.owner.get('/api/inspector/summary?all=1'));
    expect(s.kpis).toMatchObject({ hands: 2, playedCents: 700, paidCents: 960, resultCents: -260 });
    expect(s.kpis.holdPct).toBeCloseTo(-260 / 700, 6);
    const pair = s.byMarket.find((m: { slug: string }) => m.slug === 'any-pair');
    expect(pair).toMatchObject({ picks: 2, hits: 1, handleCents: 200, paidCents: 500, verdict: 'low_volume' });
    expect(s.byTable.map((t: { name: string; idle: boolean }) => [t.name, t.idle])).toEqual([['Main', false], ['Idle', true]]);
    const alice = s.byPlayer.find((p: { name: string }) => p.name === 'alice');
    expect(alice).toMatchObject({ playedCents: 500, wonCents: 460, resultCents: 40, inCents: 10_000, balanceCents: 10_000 - 500 + 460 });
  });

  it('validates the shift range', async () => {
    const f = await evening();
    expect(errCode(await f.owner.get('/api/inspector/report'))).toBe('report.range_invalid');
    expect(errCode(await f.owner.get('/api/inspector/report?fromDatetime=nope&toDatetime=2026-01-01T00:00:00Z'))).toBe('report.range_invalid');
    const now = env.clock.now().toISOString();
    expect(errCode(await f.owner.get(`/api/inspector/report?fromDatetime=${now}&toDatetime=${now}`))).toBe('report.range_order');
  });

  it('reports Points in/out, play and markets for the shift, with CSV', async () => {
    const f = await evening();
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const r = ok(await f.owner.get(`/api/inspector/report?fromDatetime=${from}&toDatetime=${to}`));
    expect(r.points).toEqual({ inCents: 30_000, outCents: 0, netCents: 30_000 });
    expect(r.play).toMatchObject({ hands: 2, playedCents: 700, paidCents: 960, holdCents: -260 });
    expect(r.tournaments).toMatchObject({ entries: 0, prizesCents: 0 });
    expect(r.byMarket.chips).toEqual([]);
    const other = ok(await f.owner.get(`/api/inspector/report?fromDatetime=${from}&toDatetime=${to}&tableIds=nothing`));
    expect(other.play.playedCents).toBe(0);
    const csv = await f.owner.get(`/api/inspector/report?fromDatetime=${from}&toDatetime=${to}&format=csv`);
    expect(csv.text).toContain('Play,House hold,-2.60');
  });
});

describe('club report', () => {
  it('shows 30-day results, players and Points for the owner, with CSV', async () => {
    const f = await evening();
    ok(await f.alice.post('/api/player/coupon').send(coupon(f.tableId, 'rainbow', 100, 4)));
    const r = ok(await f.owner.get('/api/inspector/club-report'));
    expect(r.results).toMatchObject({ flops: 2, playedCents: 700, paidCents: 960, resultCents: -260, ridingCents: 400, ridingCoupons: 1 });
    expect(r.players).toMatchObject({ active: 2 });
    expect(r.players.top.map((p: { name: string }) => p.name)).toEqual(['alice', 'bob']);
    expect(r.points).toMatchObject({
      issuedCents: 30_000, sentCents: 30_000, intoCouponsCents: 700 + 400, wonCents: 960,
      playersHoldCents: 30_000 - 700 + 960 - 400, clubHoldsCents: 700 - 960,
    });
    expect(r.diamonds).toEqual({ measuredPlayD: 7, pilot: true });
    const csv = await f.owner.get('/api/inspector/club-report?format=csv');
    expect(csv.text).toContain('Results,Club result,-2.60');
  });

  it('is for owner or manager only', async () => {
    const f = await evening();
    await grantRole(env, f.clubId, f.bob.userId, 'inspector');
    expect(errCode(await f.bob.get('/api/inspector/club-report'))).toBe('club.capability_missing');
    expect(ok(await f.bob.get('/api/inspector/reports')).segments).toEqual(['live', 'hands', 'analytics', 'report']);
    expect(ok(await f.owner.get('/api/inspector/reports')).segments).toContain('club');
  });
});

describe('analytics and sessions', () => {
  it('breaks the handle down by market, dealer and table, filtered by source', async () => {
    const f = await evening();
    const a = ok(await f.owner.get('/api/inspector/analytics'));
    expect(a.scope.kind).toBe('last24h');
    expect(a).toMatchObject({ handleCents: 700, ggrCents: -260, hands: 2, picks: 4, players: 2, notRecorded: 0 });
    expect(a.byDealer).toEqual([expect.objectContaining({ dealerId: f.dealer.userId, name: 'dealer', auto: false, handleCents: 700 })]);
    expect(a.byTable).toEqual([expect.objectContaining({ tableId: f.tableId, handleCents: 700 })]);
    expect(a.drift).toMatchObject({ ok: true, driftingCount: 0 });
    expect(ok(await f.owner.get('/api/inspector/analytics?source=auto')).handleCents).toBe(0);
    expect(errCode(await f.owner.get('/api/inspector/analytics?sessionId=nope'))).toBe('session.not_found');
  });

  it('opens, closes with a summary and starts the next session at once', async () => {
    syncClock(env);
    const f = await openFloor(env);
    expect(ok(await f.owner.get('/api/inspector/session'))).toEqual({ open: null, recent: [] });
    expect(errCode(await f.owner.post('/api/inspector/session/close'))).toBe('session.not_found');
    const opened = ok(await f.owner.post('/api/inspector/session/open'));
    expect(opened.number).toBe(1);
    expect(ok(await f.owner.post('/api/inspector/session/open')).id).toBe(opened.id);
    env.clock.advance(60_000);
    await playHand(f, ['Qc', '7h', '3s'], async () => {
      ok(await f.alice.post('/api/player/coupon').send(coupon(f.tableId, 'rainbow', 200)));
    });
    env.clock.advance(1_000);
    const { closed, next } = ok(await f.owner.post('/api/inspector/session/close'));
    expect(closed).toMatchObject({ number: 1, closedReason: 'manual', summary: { hands: 1, players: 1, handleCents: 200, resultCents: -260 } });
    expect(next).toMatchObject({ number: 2, closedAt: null });
    const a = ok(await f.owner.get(`/api/inspector/analytics?sessionId=${closed.id}`));
    expect(a.scope).toMatchObject({ kind: 'session', sessionNumber: 1 });
    expect(a.handleCents).toBe(200);
  });

  it('closes an open session by itself at 06:00 club time', async () => {
    const f = await openFloor(env);
    // Clock: 2026-09-24 18:00Z = 21:00 Athens. Cut-off: 2026-09-25 03:00Z.
    env.clock.advance(-env.clock.now().getTime() + Date.parse('2026-09-24T18:00:00Z'));
    ok(await f.owner.post('/api/inspector/session/open'));
    env.clock.advance(8 * 3_600_000 + 59 * 60_000);
    expect(ok(await f.owner.get('/api/inspector/session')).open).not.toBeNull();
    env.clock.advance(2 * 60_000);
    const s = ok(await f.owner.get('/api/inspector/session'));
    expect(s.open).toBeNull();
    expect(s.recent[0]).toMatchObject({ number: 1, closedReason: 'auto', closedAt: '2026-09-25T03:00:00.000Z' });
  });
});
