import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clubTables, hands } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { grantRole, setupClub } from '../../test/fixtures.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv({ bettingTimerSeconds: 30 }); });
afterEach(async () => { await env.close(); });

interface Setup { clubId: string; owner: Agent; dealer: Agent; alice: Agent; bob: Agent; tableId: string }

async function openTable(): Promise<Setup> {
  const { clubId, owner, players: [dealer, alice, bob] } = await setupClub(env, { players: ['dealer', 'alice', 'bob'], pointsEach: 100 });
  await grantRole(env, clubId, dealer!.userId, 'dealer');
  const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'Table 1', game: 'nlh' }));
  ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({ dealerId: dealer!.userId }));
  return { clubId, owner, dealer: dealer!, alice: alice!, bob: bob!, tableId: table.id };
}

const coupon = (tableId: string, markets: string[], stakeCents: number, rounds: number) =>
  ({ tableId, rounds, selections: markets.map((market) => ({ market, stakeCents })) });

async function deal(s: Setup, cards: [string, string, string]): Promise<void> {
  ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/start-hand`));
  ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/enter-flop`).send({ card1: cards[0], card2: cards[1], card3: cards[2] }));
}

/** Inserts settled hands directly (fast path for a full 50-flop window). */
async function insertSettled(clubId: string, tableId: string, flops: string[][], opts: { tournamentId?: string; from?: number } = {}) {
  const from = opts.from ?? 1;
  await env.db.insert(hands).values(flops.map((f, i) => ({
    clubId, tableId, tournamentId: opts.tournamentId ?? null, handNumber: from + i, status: 'settled' as const,
    card1: f[0], card2: f[1], card3: f[2], settledAt: env.clock.now(),
  })));
}

describe('GET /player/table/:id/heat', () => {
  it('counts settled flops on the table, oldest first, and skips cancelled hands', async () => {
    const s = await openTable();
    await deal(s, ['Qc', '7h', '3s']);
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/start-hand`));
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/cancel-hand`));
    await deal(s, ['7h', '7d', '2h']);

    const heat = ok(await s.alice.get(`/api/player/table/${s.tableId}/heat`));
    expect(heat).toMatchObject({ window: 50, flopsCounted: 2, hot: [], cold: [] });
    const pair = heat.markets.find((m: { slug: string }) => m.slug === 'any-pair');
    expect(pair).toMatchObject({ hits: 1, hitSeq: [false, true], judged: false, state: 'normal' });
  });

  it('calls hot and cold once 50 flops are in', async () => {
    const s = await openTable();
    await insertSettled(s.clubId, s.tableId, Array.from({ length: 60 }, () => ['Qc', '7h', '3s']));
    const heat = ok(await s.alice.get(`/api/player/table/${s.tableId}/heat`));
    expect(heat.flopsCounted).toBe(50);
    expect(heat.hot).toContain('rainbow');
    expect(heat.cold).toContain('any-pair');
    expect(heat.markets.every((m: { judged: boolean }) => m.judged)).toBe(true);
  });

  it('counts only the running tournament on a tournament table', async () => {
    const s = await openTable();
    await env.db.update(clubTables).set({ kind: 'tournament', tournamentId: 'T-new' }).where(eq(clubTables.id, s.tableId));
    await insertSettled(s.clubId, s.tableId, [['Qc', '7h', '3s'], ['Ah', 'Ad', '2c']], { tournamentId: 'T-old' });
    await insertSettled(s.clubId, s.tableId, [['7h', '7d', '2h']], { tournamentId: 'T-new', from: 3 });
    const heat = ok(await s.alice.get(`/api/player/table/${s.tableId}/heat`));
    expect(heat.flopsCounted).toBe(1);
    expect(heat.markets.find((m: { slug: string }) => m.slug === 'any-pair').hits).toBe(1);
  });

  it('refuses tables of another club and people outside the club', async () => {
    const s = await openTable();
    const outsider = await env.login('outsider');
    expect(errCode(await outsider.get(`/api/player/table/${s.tableId}/heat`).set('X-Club-Id', s.clubId))).toBe('club.access_denied');
    expect(errCode(await s.alice.get('/api/player/table/nope/heat'))).toBe('table.not_found');
  });
});

describe('GET /player/table/:id/stats', () => {
  it('reports players, picks and Points played on the current hand', async () => {
    const s = await openTable();
    const empty = ok(await s.alice.get(`/api/player/table/${s.tableId}/stats`));
    expect(empty).toEqual({ hand: null, players: 0, picks: 0, playedCents: 0, bettingTimerSeconds: 30 });

    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/start-hand`));
    ok(await s.alice.post('/api/player/coupon').send(coupon(s.tableId, ['rainbow', 'any-pair'], 200, 2)));
    ok(await s.bob.post('/api/player/coupon').send(coupon(s.tableId, ['has-ace'], 100, 1)));
    const live = ok(await s.alice.get(`/api/player/table/${s.tableId}/stats`));
    expect(live).toMatchObject({ hand: { handNumber: 1, status: 'betting_open' }, players: 2, picks: 3, playedCents: 500 });

    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/enter-flop`).send({ card1: 'Qc', card2: '7h', card3: '3s' }));
    const after = ok(await s.alice.get(`/api/player/table/${s.tableId}/stats`));
    expect(after).toMatchObject({ hand: { handNumber: 1, status: 'settled' }, players: 2, picks: 3, playedCents: 500 });
  });

  it('does not count refunded picks of a cancelled hand', async () => {
    const s = await openTable();
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/start-hand`));
    ok(await s.alice.post('/api/player/coupon').send(coupon(s.tableId, ['rainbow'], 200, 2)));
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/cancel-hand`));
    expect(ok(await s.alice.get(`/api/player/table/${s.tableId}/stats`)))
      .toMatchObject({ hand: { status: 'cancelled' }, players: 0, picks: 0, playedCents: 0 });
  });
});

describe('GET /player/tables/latest-settled', () => {
  it('returns the last settled hand per table with my own picks', async () => {
    const s = await openTable();
    ok(await s.alice.post('/api/player/coupon').send(coupon(s.tableId, ['rainbow', 'any-pair'], 100, 1)));
    ok(await s.bob.post('/api/player/coupon').send(coupon(s.tableId, ['has-ace'], 100, 1)));
    await deal(s, ['Qc', '7h', '3s']);

    const { tables } = ok(await s.alice.get(`/api/player/tables/latest-settled?ids=${s.tableId},unknown`));
    expect(Object.keys(tables)).toEqual([s.tableId]);
    const entry = tables[s.tableId];
    expect(entry).toMatchObject({ handNumber: 1, cards: ['Qc', '7h', '3s'], isTournament: false });
    expect(entry.matchingSlugs).toContain('rainbow');
    expect(entry.mine.map((b: { market: string; status: string; payoutCents: number }) => [b.market, b.status, b.payoutCents]).sort())
      .toEqual([['any-pair', 'lost', 0], ['rainbow', 'won', 230]]);
    expect(entry.wonCents).toBe(230);
  });

  it('leaves out tables of clubs I am not in and tables without a settled hand', async () => {
    const s = await openTable();
    await deal(s, ['Qc', '7h', '3s']);
    const outsider = await env.login('outsider');
    expect(ok(await outsider.get(`/api/player/tables/latest-settled?ids=${s.tableId}`)).tables).toEqual({});
    const { table: fresh } = ok(await s.owner.post('/api/inspector/table').send({ name: 'Fresh' }));
    expect(ok(await s.alice.get(`/api/player/tables/latest-settled?ids=${fresh.id}`)).tables).toEqual({});
  });

  it('validates the id list', async () => {
    const s = await openTable();
    expect(errCode(await s.alice.get('/api/player/tables/latest-settled'))).toBe('validation.invalid');
    const many = Array.from({ length: 21 }, (_, i) => `t${i}`).join(',');
    expect(errCode(await s.alice.get(`/api/player/tables/latest-settled?ids=${many}`))).toBe('validation.invalid');
  });
});
