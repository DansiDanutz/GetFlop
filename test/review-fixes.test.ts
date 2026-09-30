// Regression tests for the issues found in code review (PR #1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { http, setup, signed } from './helpers.ts';
import type { FetchFn } from '../src/wallet.ts';

const DAY = 86_400_000;

test('check-in while a seamless debit is in flight: the seat holds and the bet is refunded when the debit confirms', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const calls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith('/debit')) await held;
    return { status: 200, text: async () => '{}' };
  };
  const s = await setup({ fetchFn });
  const op = await s.app.accounts.createOperator({ name: 'Casino X', currency: 'EUR', walletMode: 'seamless', walletUrl: 'https://w.example/gf' }, s.admin);
  const p = await s.app.accounts.upsertPlayer(await s.app.accounts.operator(op.id), 'x1', 'Xena');
  const round = await s.app.game.openRound(s.table.id, 'staff:dealer');

  const betting = s.app.game.placeBet(p, { roundId: round.id, marketId: 'HAS_ACE', stake: 1000 });
  const seat = await s.app.game.seatPlayer(s.table.id, p.id, 'staff:dealer'); // must not fail
  assert.equal(seat.playerId, p.id);
  release();
  await assert.rejects(betting, { code: 'SEATED_AT_TABLE' });

  assert.equal(await s.app.game.seatOf(p.id), s.table.id);
  const bet = (await s.app.db.get('SELECT status FROM bets WHERE player_id = ?', p.id))!;
  assert.equal(bet.status, 'refunded');
  assert.equal((await s.app.db.get("SELECT COUNT(*) AS n FROM outbox WHERE action = 'credit'"))!.n, 1); // refund to the partner wallet
  assert.equal((await s.app.game.roundRisk(round.id)).EUR.stakes, 0);
  await assert.rejects(s.app.game.placeBet(p, { roundId: round.id, marketId: 'HAS_ACE', stake: 1000 }), { code: 'SEATED_AT_TABLE' });
  await s.app.game.closeRound(round.id, 'd');
  await s.app.game.submitFlop(round.id, ['Ah', '2c', '3d'], 'd'); // nothing pending any more
  assert.equal((await s.app.ledger.verify()).ok, true);
});

test('tournaments refuse blocked players and suspended partners', async () => {
  const s = await setup();
  const t = await s.app.tournaments.create({ name: 'R', startsAt: s.clock.t, endsAt: s.clock.t + DAY }, s.admin);
  const a = await s.player('a');
  const b = await s.player('b');
  await s.app.tournaments.join(t.id, a);
  const round = await s.app.game.openRound(s.table.id, 'd');

  await s.app.accounts.setPlayerStatus(s.opRow, 'a', 'blocked');
  await assert.rejects(async () => s.app.tournaments.placeBet(t.id, a, { roundId: round.id, marketId: 'RAINBOW', stake: 10 }), { code: 'PLAYER_BLOCKED' });

  await s.app.accounts.updateOperator(s.op.id, { status: 'suspended' }, s.admin);
  await assert.rejects(async () => s.app.tournaments.join(t.id, b), { code: 'OPERATOR_SUSPENDED' });
  await s.app.accounts.updateOperator(s.op.id, { status: 'active' }, s.admin);
  await s.app.tournaments.join(t.id, b);
  await s.app.accounts.updateOperator(s.op.id, { status: 'suspended' }, s.admin);
  await assert.rejects(async () => s.app.tournaments.placeBet(t.id, b, { roundId: round.id, marketId: 'RAINBOW', stake: 10 }), { code: 'OPERATOR_SUSPENDED' });
});

test('partner wallet payments keep retrying past the alert threshold and can be retried on demand', async () => {
  let up = false;
  const fetchFn: FetchFn = async (url) => {
    if (new URL(url).pathname.endsWith('/debit')) return { status: 200, text: async () => '{}' };
    if (!up) throw new Error('down');
    return { status: 200, text: async () => '{}' };
  };
  const s = await setup({ fetchFn });
  const op = await s.app.accounts.createOperator({ name: 'W', currency: 'EUR', walletMode: 'seamless', walletUrl: 'https://w.example' }, s.admin);
  const p = await s.app.accounts.upsertPlayer(await s.app.accounts.operator(op.id), 'w1', 'W1');
  const r = await s.app.game.openRound(s.table.id, 'd');
  await s.app.game.placeBet(p, { roundId: r.id, marketId: 'HAS_ACE', stake: 1000 });
  await s.app.game.closeRound(r.id, 'd');
  await s.app.game.submitFlop(r.id, ['Ah', '2c', '3d'], 'd');

  for (let i = 0; i < 30; i++) {
    if (i) s.advance(700_000); // past the longest backoff
    await s.app.wallet.deliverDue();
  }
  const row = (await s.app.db.get('SELECT * FROM outbox'))!;
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 30);
  assert.equal((await s.app.wallet.stuck()).length, 1);
  assert.equal((await s.app.audit.list(50, 'outbox.stuck')).length, 1); // alerted once

  up = true;
  await s.app.wallet.deliverDue(); // not due yet: waits for its backoff
  assert.equal((await s.app.db.get('SELECT status FROM outbox'))!.status, 'pending');
  assert.deepEqual(await s.app.wallet.retryNow(op.id), { scheduled: 1 });
  assert.equal(await s.app.wallet.deliverDue(), 1);
  assert.equal((await s.app.wallet.stuck()).length, 0);
});

test('invoices are contiguous and use the rate agreed for their period', async () => {
  const s = await setup();
  const p = await s.player('p', 1_000_000);
  const lose = async () => {
    const r = await s.app.game.openRound(s.table.id, 'd');
    await s.app.game.placeBet(p, { roundId: r.id, marketId: 'TWO_TONE', stake: 100_000 });
    await s.app.game.closeRound(r.id, 'd');
    await s.app.game.submitFlop(r.id, ['Ah', 'Kd', '2c'], 'd'); // player loses: GGR +100,000
  };
  const created = s.clock.t;
  s.advance(1000);
  await lose();
  s.advance(DAY);
  const t1 = s.clock.t;
  // A gap would leave bets unbilled.
  await assert.rejects(async () => s.app.billing.createInvoice(s.op.id, created + 5000, t1, s.admin), { code: 'PERIOD_NOT_CONTIGUOUS' });
  // The rate changes after the period ended: the old rate (20%) still applies to it.
  s.advance(1000);
  await s.app.accounts.updateOperator(s.op.id, { commissionBps: 3000 }, s.admin);
  const inv1 = await s.app.billing.createInvoice(s.op.id, undefined, t1, s.admin);
  assert.equal(inv1.period_from, created);
  assert.equal(inv1.commission_bps, 2000);
  assert.equal(inv1.commission, 20_000);

  s.advance(DAY);
  await lose();
  s.advance(1000);
  // This period would span the rate change, so it must be split at the change.
  await assert.rejects(async () => s.app.billing.createInvoice(s.op.id, undefined, s.clock.t, s.admin), { code: 'RATE_CHANGED_IN_PERIOD' });
  const changeAt = (await s.app.db.get('SELECT MAX(effective_from) AS t FROM commission_rates WHERE operator_id = ?', s.op.id))!.t;
  const inv2 = await s.app.billing.createInvoice(s.op.id, undefined, changeAt, s.admin);
  assert.equal(inv2.ggr, 0);
  const inv3 = await s.app.billing.createInvoice(s.op.id, undefined, s.clock.t, s.admin);
  assert.equal(inv3.commission_bps, 3000);
  assert.equal(inv3.commission, 30_000);
});

test('a transfer txId identifies exactly one transfer', async () => {
  const s = await setup();
  await s.player('u', 0);
  await s.app.accounts.transfer(s.opRow, 'deposit', { playerId: 'u', amount: 5000, txId: 't1' });
  assert.equal((await s.app.accounts.transfer(s.opRow, 'deposit', { playerId: 'u', amount: 5000, txId: 't1' })).balance, 5000);
  await assert.rejects(async () => s.app.accounts.transfer(s.opRow, 'withdraw', { playerId: 'u', amount: 5000, txId: 't1' }), { code: 'TX_ID_REUSED' });
  await assert.rejects(async () => s.app.accounts.transfer(s.opRow, 'deposit', { playerId: 'u', amount: 7000, txId: 't1' }), { code: 'TX_ID_REUSED' });
  await s.player('v', 0);
  await assert.rejects(async () => s.app.accounts.transfer(s.opRow, 'deposit', { playerId: 'v', amount: 5000, txId: 't1' }), { code: 'TX_ID_REUSED' });
  assert.equal((await s.app.accounts.transfer(s.opRow, 'withdraw', { playerId: 'u', amount: 2000, txId: 't2' })).balance, 3000);
  assert.equal((await s.app.accounts.transfer(s.opRow, 'withdraw', { playerId: 'u', amount: 2000, txId: 't2' })).balance, 3000);
});

test('the reconciliation feed pages through bets placed at the same millisecond', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const p = await s.player('many', 10_000_000);
  const r = await s.app.game.openRound(s.table.id, 'd');
  for (let i = 0; i < 25; i++) await s.app.game.placeBet(p, { roundId: r.id, marketId: 'NO_PAIR', stake: 100 });
  const seen = new Set<string>();
  let cursor: string | null = '';
  let pages = 0;
  while (cursor !== null) {
    const path = `/v1/operator/bets?from=0&limit=10${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await http(s.app, 'GET', path, undefined, signed(s.op, s.clock.t, 'GET', path, undefined));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res.body.bets.forEach((b: any) => seen.add(b.id));
    cursor = res.body.nextCursor;
    pages++;
  }
  assert.equal(pages, 3);
  assert.equal(seen.size, 25);
});

test('table limits apply to each currency separately', async () => {
  const s = await setup();
  await s.app.game.updateTable(s.table.id, { maxRoundLiability: 10_000 }, s.admin);
  const usd = await s.app.accounts.createOperator({ name: 'US', currency: 'USD' }, s.admin);
  const usdRow = await s.app.accounts.operator(usd.id);
  const e = await s.player('eur-player', 1_000_000);
  const u = await s.app.accounts.upsertPlayer(usdRow, 'usd-player', 'U');
  await s.app.accounts.transfer(usdRow, 'deposit', { playerId: 'usd-player', amount: 1_000_000, txId: 'd' });
  const r = await s.app.game.openRound(s.table.id, 'd');
  await s.app.game.placeBet(e, { roundId: r.id, marketId: 'RAINBOW', stake: 7000 });
  await assert.rejects(s.app.game.placeBet(e, { roundId: r.id, marketId: 'RAINBOW', stake: 1000 }), { code: 'TABLE_LIMIT_REACHED' });
  await s.app.game.placeBet(u, { roundId: r.id, marketId: 'RAINBOW', stake: 7000 });
  assert.deepEqual(Object.keys(await s.app.game.roundRisk(r.id)).sort(), ['EUR', 'USD']);
});

test('transfers recorded under the old deposit/withdraw kinds are still recognised on retry', async () => {
  const s = await setup();
  const p = await s.player('legacy', 0);
  // What the previous version wrote for a deposit of 1000 (t-old-1) and a withdrawal of 200 (t-old-2).
  await s.app.ledger.transfer('deposit', `${s.op.id}:t-old-1`, 'EUR', `operator:${s.op.id}`, `player:${p.id}`, 1000);
  await s.app.ledger.transfer('withdraw', `${s.op.id}:t-old-2`, 'EUR', `player:${p.id}`, `operator:${s.op.id}`, 200);
  assert.equal((await s.app.accounts.transfer(s.opRow, 'deposit', { playerId: 'legacy', amount: 1000, txId: 't-old-1' })).balance, 800);
  assert.equal((await s.app.accounts.transfer(s.opRow, 'withdraw', { playerId: 'legacy', amount: 200, txId: 't-old-2' })).balance, 800);
  await assert.rejects(async () => s.app.accounts.transfer(s.opRow, 'withdraw', { playerId: 'legacy', amount: 1000, txId: 't-old-1' }), { code: 'TX_ID_REUSED' });
});

test('a legacy txId used once in each direction answers both retries', async () => {
  const s = await setup();
  const p = await s.player('both', 0);
  await s.app.ledger.transfer('deposit', `${s.op.id}:same`, 'EUR', `operator:${s.op.id}`, `player:${p.id}`, 1000);
  await s.app.ledger.transfer('withdraw', `${s.op.id}:same`, 'EUR', `player:${p.id}`, `operator:${s.op.id}`, 200);
  assert.equal((await s.app.accounts.transfer(s.opRow, 'deposit', { playerId: 'both', amount: 1000, txId: 'same' })).balance, 800);
  assert.equal((await s.app.accounts.transfer(s.opRow, 'withdraw', { playerId: 'both', amount: 200, txId: 'same' })).balance, 800);
  await assert.rejects(async () => s.app.accounts.transfer(s.opRow, 'withdraw', { playerId: 'both', amount: 300, txId: 'same' }), { code: 'TX_ID_REUSED' });
});
