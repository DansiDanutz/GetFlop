import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ledgerEntries, users } from '../../db/schema/index.js';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { couponBody, flop, openTable, startHand, type TableSetup } from './testkit.js';

let env: TestEnv;
let admin: Agent;
let s: TableSetup;

/** Alice: Rainbow 2 PTS (wins 4.60) and Any Pair 1 PTS (loses) on hand 1; Bob's coupon stays live. */
beforeEach(async () => {
  env = await createTestEnv({ bettingTimerSeconds: 0 });
  admin = await env.login('boss', { admin: true });
  s = await openTable(env);
  ok(await s.alice.post('/api/player/coupon').send(couponBody(s.tableId, ['rainbow', 'any-pair'], 200)));
  await startHand(s.dealer, s.tableId);
  await flop(s.dealer, s.tableId, ['Qc', '7h', '3s']);
  ok(await s.bob.post('/api/player/coupon').send(couponBody(s.tableId, ['has-ace'], 100, 2)));
  // Ledger rows are stamped by the database clock; align them with the test clock's club day.
  await env.db.update(ledgerEntries).set({ createdAt: env.clock.now() });
});
afterEach(async () => { await env.close(); });

describe('platform overview', () => {
  it('reports KPIs and per-club figures without adding clubs together', async () => {
    const other = await openTable(env, 'Second Club', 'x');
    const data = ok(await admin.get('/api/admin/platform?dateStart=2026-09-01&dateEnd=2026-09-30&tz=Europe/Athens'));
    expect(data.health).toMatchObject({ dbMs: expect.any(Number), connections: 0 });
    expect(data.kpis).toMatchObject({ handsDealt: 1, clubsWithHands: 1, playersWhoPlayed: 1, couponsBought: 2, liveCoupons: 1, clubs: 2, tablesOpen: 2 });
    const club = data.clubs.find((c: { clubId: string }) => c.clubId === s.clubId);
    expect(club).toMatchObject({ hands: 1, players: 1, playedCents: 400, wonCents: 460, resultCents: -60, ridingCents: 200 });
    expect(data.idleClubs).toBe(1);
    expect(data.clubs.find((c: { clubId: string }) => c.clubId === other.clubId)).toMatchObject({ hands: 0 });
    const rainbow = data.markets.find((m: { slug: string }) => m.slug === 'rainbow');
    expect(rainbow).toMatchObject({ picks: 1, hits: 1, verdict: 'too_few', retired: false });
    expect(data.devices.list.length).toBeGreaterThan(0);
  });

  it('leaves bots out of club figures', async () => {
    await env.db.update(users).set({ isBot: true }).where(eq(users.id, s.alice.userId));
    const data = ok(await admin.get('/api/admin/platform'));
    expect(data.clubs[0]).toMatchObject({ players: 0, playedCents: 0 });
    expect(data.kpis.playersWhoPlayed).toBe(0);
  });

  it('validates the period', async () => {
    expect(errCode(await admin.get('/api/admin/platform?dateStart=2026-09-30&dateEnd=2026-09-01'))).toBe('report.range_order');
    expect(errCode(await admin.get('/api/admin/platform?dateStart=bad&dateEnd=2026-09-01'))).toBe('report.range_invalid');
    expect(errCode(await admin.get('/api/admin/platform?tz=Mars/Base'))).toBe('validation.invalid');
  });

  it('builds the dashboard', async () => {
    const data = ok(await admin.get('/api/admin'));
    expect(data.accounts).toMatchObject({ all: 5, admins: 1, inactive: 0 });
    expect(data.clubs).toBe(1);
    expect(data.today).toMatchObject({ hands: 1, players: 1, coupons: 2 });
    expect(data.todayClubs).toEqual([expect.objectContaining({ clubId: s.clubId, playedCents: 400, wonCents: 460, resultCents: -60 })]);
    expect(data.live).toMatchObject({ liveCoupons: 1, tablesOpen: 1 });
    expect(data.driftingClubs).toEqual([]);
  });
});

describe('live, tables and hands', () => {
  it('shows tables with live coupons and the hand in play', async () => {
    await startHand(s.dealer, s.tableId);
    const live = ok(await admin.get('/api/admin/live'));
    expect(live.tables).toHaveLength(1);
    expect(live.tables[0]).toMatchObject({ tableId: s.tableId, clubName: 'Sharks Imperial', dealerName: 'dealer', liveCoupons: 1, hand: { handNumber: 2, status: 'betting_open', picks: 1, stakeCents: 100 } });
    expect(live.totals).toMatchObject({ liveHands: 1, pendingPicks: 1, pendingStakeCents: 100, liveCoupons: 1 });
  });

  it('lists all tables for the picker', async () => {
    const { tables } = ok(await admin.get('/api/admin/tables'));
    expect(tables).toEqual([expect.objectContaining({ id: s.tableId, name: 'Table 1', clubName: 'Sharks Imperial', kind: 'cash', status: 'open' })]);
  });

  it('filters hands by table, number and dates', async () => {
    const all = ok(await admin.get('/api/admin/hands'));
    expect(all.hands[0]).toMatchObject({ handNumber: 1, tableName: 'Table 1', flop: ['Qc', '7h', '3s'], status: 'settled', picks: 2, playedCents: 400, paidCents: 460, resultCents: -60 });
    expect(ok(await admin.get(`/api/admin/hands?tableId=${s.tableId}&handNumber=2`)).hands).toEqual([]);
    expect(ok(await admin.get('/api/admin/hands?dateStart=2026-09-01&dateEnd=2026-09-02&tz=Europe/Athens')).hands).toEqual([]);
  });
});

describe('financials', () => {
  it('reconciles each club day and checks each supply', async () => {
    const data = ok(await admin.get('/api/admin/financials/reconciliation?tz=Europe/Athens'));
    expect(data.days).toEqual([expect.objectContaining({
      date: '2026-09-24', clubId: s.clubId, picks: 2, playedCents: 400, wonCents: 460, resultCents: -60, sentCents: 30_000, claimedCents: 0,
    })]);
    expect(data.clubs).toEqual([expect.objectContaining({ clubId: s.clubId, drift: 0, ridingCents: 200 })]);
  });

  it('shows the players of today with in, out, balance and played', async () => {
    const data = ok(await admin.get('/api/admin/financials/daily-player-net?tz=Europe/Athens'));
    const alice = data.players.find((p: { userId: string }) => p.userId === s.alice.userId);
    expect(alice).toMatchObject({ clubName: 'Sharks Imperial', inCents: 10_000, outCents: 0, balanceCents: 10_000 - 400 + 460, playedCents: 400, wonCents: 460 });
    expect(data.players.find((p: { userId: string }) => p.userId === s.dealer.userId)).toBeUndefined();
  });
});

describe('audit log and more menu', () => {
  it('pages and filters the audit log', async () => {
    ok(await admin.put(`/api/admin/users/${s.bob.userId}/toggle-active`).send({ active: false }));
    env.clock.advance(1_000);
    ok(await admin.put(`/api/admin/users/${s.bob.userId}/toggle-active`).send({ active: true }));
    env.clock.advance(1_000);
    ok(await admin.put(`/api/admin/users/${s.bob.userId}/reset-pin`).send({ newPin: '5555' }));
    const all = ok(await admin.get(`/api/admin/audit?limit=2&targetId=${s.bob.userId}`));
    expect(all.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(all.logs[0]).toMatchObject({ action: 'reset_pin', actorName: 'boss', targetName: 'bob' });
    expect(all.actions).toEqual(expect.arrayContaining(['activate_user', 'deactivate_user', 'reset_pin']));
    const filtered = ok(await admin.get('/api/admin/audit?action=deactivate_user'));
    expect(filtered.logs.map((l: { action: string }) => l.action)).toEqual(['deactivate_user']);
    expect(ok(await admin.get(`/api/admin/audit?page=2&limit=2&targetId=${s.bob.userId}`)).logs).toHaveLength(1);
  });

  it('lists the More sections and opens each one', async () => {
    const { sections } = ok(await admin.get('/api/admin/more'));
    expect(sections.map((x: { key: string }) => x.key)).toEqual(['hands', 'reconciliation', 'audit', 'bettypes', 'arena', 'appqr']);
    expect(ok(await admin.get('/api/admin/more/hands')).data.hands).toHaveLength(1);
    expect(ok(await admin.get('/api/admin/more/bettypes')).data.betTypes.length).toBeGreaterThan(20);
    expect(ok(await admin.get('/api/admin/more/appqr')).data).toEqual({ url: 'http://localhost:5173' });
    expect(ok(await admin.get('/api/admin/more/arena')).data).toEqual({ endpoint: '/admin/platform/arena' });
    expect(errCode(await admin.get('/api/admin/more/nope'))).toBe('admin.section_not_found');
  });
});
