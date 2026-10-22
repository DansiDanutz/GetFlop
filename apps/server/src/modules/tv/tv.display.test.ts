import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, ok, type TestEnv } from '../../test/harness.js';
import { openCashTable, pairCash, pick, tv, type TvSetup } from './tv.fixtures.js';

let env: TestEnv;
let s: TvSetup;
let token: string;

beforeEach(async () => {
  env = await createTestEnv({ bettingTimerSeconds: 30 });
  s = await openCashTable(env);
  token = await pairCash(env, s.owner, s.tableId);
});
afterEach(async () => { await env.close(); });

const display = async () => ok(await tv(env).get(`/api/tv/cash/${token}`));
const flop = (card1: string, card2: string, card3: string) => ({ card1, card2, card3 });

describe('Ring Game TV payload', () => {
  it('shows the table header, the join QR link and a waiting state before the first hand', async () => {
    const data = await display();
    expect(data.table).toMatchObject({
      name: 'Table 1', status: 'open', clubName: 'Sharks Imperial', joinCode: s.joinCode,
      joinUrl: `http://localhost:5173/#/join/${s.joinCode}`,
    });
    expect(data.hand).toBeNull();
    expect(data.markets).toEqual([]);
    expect(data.recent).toEqual([]);
    expect(data.serverNow).toBe(env.clock.now().toISOString());
  });

  it('shows the countdown and the most picked markets while picks are open', async () => {
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/start-hand`));
    ok(await s.alice.post('/api/player/coupon').send(pick(s.tableId, ['rainbow', 'any-pair'], 200)));
    ok(await s.bob.post('/api/player/coupon').send(pick(s.tableId, ['rainbow'], 500)));
    const data = await display();
    expect(data.hand).toMatchObject({ handNumber: 1, status: 'betting_open', cards: null, players: 2, bets: 3, stakedCents: 900 });
    expect(new Date(data.hand.bettingClosesAt).getTime()).toBe(env.clock.now().getTime() + 30_000);
    expect(data.bettingTimerSeconds).toBe(30);
    expect(data.markets).toEqual([
      { slug: 'rainbow', name: 'Rainbow', picks: 2, players: 2 },
      { slug: 'any-pair', name: 'Any Pair', picks: 1, players: 1 },
    ]);
  });

  it('shows the flop, the markets that came and the hand totals after the settle', async () => {
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/start-hand`));
    ok(await s.alice.post('/api/player/coupon').send(pick(s.tableId, ['rainbow'], 200)));
    ok(await s.bob.post('/api/player/coupon').send(pick(s.tableId, ['any-pair'], 100)));
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/enter-flop`).send(flop('Qc', '7h', '3s')));
    const data = await display();
    expect(data.hand).toMatchObject({
      handNumber: 1, status: 'settled', cards: ['Qc', '7h', '3s'],
      winningMarkets: [{ slug: 'rainbow', name: 'Rainbow' }],
      players: 2, bets: 2, stakedCents: 300, paidOutCents: 460, winners: 1,
    });
    expect(data.recent).toEqual([{ handNumber: 1, cards: ['Qc', '7h', '3s'], winningMarkets: ['rainbow'] }]);
  });

  it('never exposes names, user ids, balances or individual picks', async () => {
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/start-hand`));
    ok(await s.alice.post('/api/player/coupon').send(pick(s.tableId, ['rainbow'], 200, 3)));
    ok(await s.bob.post('/api/player/coupon').send(pick(s.tableId, ['has-ace'], 100, 2)));
    const open = JSON.stringify(await display());
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/enter-flop`).send(flop('Ac', '7h', '3s')));
    const settled = JSON.stringify(await display());
    for (const text of [open, settled]) {
      for (const secret of ['alice', 'bob', 'dealer', 'owner', s.alice.userId, s.bob.userId, s.dealer.userId]) {
        expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
      }
      expect(text).not.toMatch(/balance|userId|username|displayName|couponId|betId|stakeCents|payoutCents/);
    }
  });

  it('keeps only the last 5 flops, newest first, and ignores cancelled hands', async () => {
    const flops = [['2c', '3d', '4h'], ['5c', '6d', '8h'], ['9c', 'Td', 'Jh'], ['Qc', 'Kd', 'Ah'], ['2s', '5s', '9s'], ['3c', '3d', 'Kh']];
    for (const [a, b, c] of flops) {
      ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/start-hand`));
      ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/enter-flop`).send(flop(a!, b!, c!)));
    }
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/start-hand`));
    ok(await s.dealer.post(`/api/dealer/table/${s.tableId}/cancel-hand`));
    const data = await display();
    expect(data.recent.map((r: { handNumber: number }) => r.handNumber)).toEqual([6, 5, 4, 3, 2]);
    expect(data.hand).toMatchObject({ handNumber: 7, status: 'cancelled' });
  });

  it('reports a closed table as off air', async () => {
    ok(await s.owner.put(`/api/inspector/table/${s.tableId}/close`));
    const data = await display();
    expect(data.table.status).toBe('closed');
  });
});
