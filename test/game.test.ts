import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';
import type { FetchFn } from '../src/wallet.ts';

const err = async (p: Promise<unknown> | (() => unknown), code: string) => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e: any) {
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`expected ${code}`);
};

test('a round from open to settled pays winners and books the result', async () => {
  const s = await setup();
  const alex = await s.player('alex');
  const maria = await s.player('maria');
  const round = await s.app.game.openRound(s.table.id, 'staff:dealer');

  const b1 = await s.app.game.placeBet(alex, { roundId: round.id, marketId: 'RAINBOW', stake: 1000 });
  const b2 = await s.app.game.placeBet(maria, { roundId: round.id, marketId: 'PAIRED', stake: 2000 });
  assert.equal(b1.oddsX100, 238);
  assert.equal(await s.balance(alex.id), 99_000);

  await s.app.game.closeRound(round.id, 'staff:dealer');
  await err(s.app.game.placeBet(alex, { roundId: round.id, marketId: 'RAINBOW', stake: 1000 }), 'BETTING_CLOSED');
  const res = await s.app.game.submitFlop(round.id, ['Ah', '7c', '2d'], 'staff:dealer');
  assert.equal(res.settled, true);
  const tv = await s.app.game.tableView(s.table.id);
  assert.ok(tv.history[0].winningMarkets.includes('RAINBOW')); // the TV screen's hit counts use this

  assert.equal(await s.balance(alex.id), 99_000 + 2380);
  assert.equal(await s.balance(maria.id), 98_000);
  assert.equal(await s.app.ledger.balance(`escrow:${round.id}`, 'EUR'), 0);
  assert.equal(await s.app.ledger.balance(`ggr:${s.op.id}`, 'EUR'), 3000 - 2380);
  const bets = await s.app.game.playerBets(alex.id);
  assert.equal(bets[0].status, 'won');
  assert.equal(bets[0].id, b1.id);
  assert.equal((await s.app.game.playerBets(maria.id))[0].id, b2.id);
  assert.equal((await s.app.ledger.verify()).ok, true);
  assert.equal((await s.app.audit.verify()).ok, true);
});

test('betting closes automatically when the window runs out', async () => {
  const s = await setup();
  const alex = await s.player('alex');
  const round = await s.app.game.openRound(s.table.id, 'staff:dealer');
  s.advance(30_000);
  await err(s.app.game.placeBet(alex, { roundId: round.id, marketId: 'RAINBOW', stake: 1000 }), 'BETTING_CLOSED');
  await s.app.game.tick();
  assert.equal((await s.app.game.round(round.id)).status, 'closed');
});

test('the flop cannot be entered while bets are open, and only once', async () => {
  const s = await setup();
  const round = await s.app.game.openRound(s.table.id, 'staff:dealer');
  await err(() => s.app.game.submitFlop(round.id, ['Ah', '7c', '2d'], 'staff:dealer'), 'ROUND_STILL_OPEN');
  await s.app.game.closeRound(round.id, 'staff:dealer');
  await err(() => s.app.game.submitFlop(round.id, ['Ah', 'Ah', '2d'], 'staff:dealer'), 'BAD_FLOP');
  await s.app.game.submitFlop(round.id, ['Ah', '7c', '2d'], 'staff:dealer');
  await err(() => s.app.game.submitFlop(round.id, ['Ks', '7c', '2d'], 'staff:dealer'), 'ROUND_FINISHED');
  await s.app.game.openRound(s.table.id, 'x');
  await err(s.app.game.openRound(s.table.id, 'x'), 'ROUND_IN_PROGRESS');
});

test('dual confirmation needs two different people entering the same flop', async () => {
  const s = await setup();
  await s.app.game.updateTable(s.table.id, { dualConfirm: true }, s.admin);
  const alex = await s.player('alex');
  const round = await s.app.game.openRound(s.table.id, 'staff:dealer');
  await s.app.game.placeBet(alex, { roundId: round.id, marketId: 'HAS_ACE', stake: 1000 });
  await s.app.game.closeRound(round.id, 'staff:dealer');

  assert.equal((await s.app.game.submitFlop(round.id, ['Ah', '7c', '2d'], 'staff:dealer')).awaitingConfirmation, true);
  await err(() => s.app.game.submitFlop(round.id, ['Ah', '7c', '2d'], 'staff:dealer'), 'NEEDS_SECOND_PERSON');
  await err(() => s.app.game.submitFlop(round.id, ['Kh', '7c', '2d'], 'staff:floor'), 'FLOP_MISMATCH');
  // After a mismatch both must enter it again.
  await s.app.game.submitFlop(round.id, ['Ah', '7c', '2d'], 'staff:dealer');
  assert.equal((await s.app.game.submitFlop(round.id, ['2d', 'Ah', '7c'], 'staff:floor')).settled, true);
  assert.equal(await s.balance(alex.id), 99_000 + 4370);
});

test('voiding a round returns every stake', async () => {
  const s = await setup();
  const alex = await s.player('alex');
  const round = await s.app.game.openRound(s.table.id, 'staff:dealer');
  await s.app.game.placeBet(alex, { roundId: round.id, marketId: 'MONOTONE', stake: 5000 });
  await s.app.game.voidRound(round.id, 'misdeal', 'staff:floor');
  assert.equal(await s.balance(alex.id), 100_000);
  assert.equal((await s.app.game.playerBets(alex.id))[0].status, 'refunded');
  assert.equal((await s.app.ledger.verify()).ok, true);
});

test('stake limits, payout cap, balance and idempotent retries', async () => {
  const s = await setup();
  const alex = await s.player('alex', 1_000);
  const round = await s.app.game.openRound(s.table.id, 'staff:dealer');
  await err(s.app.game.placeBet(alex, { roundId: round.id, marketId: 'RAINBOW', stake: 50 }), 'STAKE_OUT_OF_RANGE');
  await err(s.app.game.placeBet(alex, { roundId: round.id, marketId: 'NOPE', stake: 100 }), 'UNKNOWN_MARKET');
  await err(s.app.game.placeBet(alex, { roundId: round.id, marketId: 'RAINBOW', stake: 2000 }), 'INSUFFICIENT_FUNDS');
  await s.app.game.updateTable(s.table.id, { maxBetPayout: 10_000 }, s.admin);
  await err(s.app.game.placeBet(alex, { roundId: round.id, marketId: 'TRIPS', stake: 100 }), 'PAYOUT_LIMIT');
  const a = await s.app.game.placeBet(alex, { roundId: round.id, marketId: 'RAINBOW', stake: 500, clientRef: 'r1' });
  const b = await s.app.game.placeBet(alex, { roundId: round.id, marketId: 'RAINBOW', stake: 500, clientRef: 'r1' });
  assert.equal(a.id, b.id);
  assert.equal(await s.balance(alex.id), 500);
});

test('the round liability cap uses the worst possible flop', async () => {
  const s = await setup();
  // Rainbow pays 2.38. With a cap of 10,000 the house can risk at most that much net.
  await s.app.game.updateTable(s.table.id, { maxRoundLiability: 10_000 }, s.admin);
  const p = await s.player('big', 1_000_000);
  const round = await s.app.game.openRound(s.table.id, 'staff:dealer');
  await s.app.game.placeBet(p, { roundId: round.id, marketId: 'RAINBOW', stake: 7000 }); // worst case 16,660 - 7,000 = 9,660
  await err(s.app.game.placeBet(p, { roundId: round.id, marketId: 'RAINBOW', stake: 1000 }), 'TABLE_LIMIT_REACHED');
  // A bet on the opposite outcome lowers the worst case, so it is accepted.
  await s.app.game.placeBet(p, { roundId: round.id, marketId: 'TWO_TONE', stake: 5000 });
  const risk = (await s.app.game.roundRisk(round.id)).EUR;
  assert.equal(risk.stakes, 12_000);
  assert.equal(risk.worstCase, 16_660 - 12_000);
});

test('seamless wallet: debit, refusal, timeout rollback and retried credits', async () => {
  const calls: { path: string; body: any }[] = [];
  let mode: 'ok' | 'broke' | 'down' = 'ok';
  const fetchFn: FetchFn = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(init.body) });
    if (mode === 'down') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    if (mode === 'broke' && path.endsWith('/debit')) return { status: 402, text: async () => '{"error":"INSUFFICIENT_FUNDS"}' };
    return { status: 200, text: async () => '{"balance":12345}' };
  };
  const s = await setup({ fetchFn });
  const op = await s.app.accounts.createOperator({ name: 'Casino X', currency: 'USD', walletMode: 'seamless', walletUrl: 'https://wallet.example/gf', commissionBps: 1500 }, s.admin);
  const p = await s.app.accounts.upsertPlayer(await s.app.accounts.operator(op.id), 'x-1', 'Xavier');
  const round = await s.app.game.openRound(s.table.id, 'staff:dealer');

  const bet = await s.app.game.placeBet(p, { roundId: round.id, marketId: 'ALL_BLACK', stake: 1000 });
  assert.equal(bet.status, 'open');
  assert.deepEqual(calls[0].path, '/gf/debit');
  assert.equal(calls[0].body.playerId, 'x-1');

  mode = 'broke';
  await err(s.app.game.placeBet(p, { roundId: round.id, marketId: 'ALL_BLACK', stake: 1000 }), 'INSUFFICIENT_FUNDS');
  mode = 'down';
  await err(s.app.game.placeBet(p, { roundId: round.id, marketId: 'ALL_BLACK', stake: 1000 }), 'WALLET_ERROR');
  assert.equal((await s.app.db.get("SELECT COUNT(*) AS n FROM outbox WHERE action = 'rollback'"))!.n, 1);

  await s.app.game.closeRound(round.id, 'staff:dealer');
  await s.app.game.submitFlop(round.id, ['As', '7c', '2s'], 'staff:dealer');
  // Credit is queued in the settlement transaction; the operator is down, so it waits and retries.
  await s.app.wallet.deliverDue();
  assert.equal((await s.app.db.get("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'"))!.n, 2);
  mode = 'ok';
  s.advance(60_000);
  assert.equal(await s.app.wallet.deliverDue(), 2);
  const credit = calls.filter((c) => c.path === '/gf/credit').at(-1)!;
  assert.deepEqual([credit.body.amount, credit.body.reason, credit.body.txId], [8070, 'win', `${bet.id}:win`]);
  assert.equal((await s.app.ledger.verify()).ok, true);
});

test('a seated player cannot bet on their own table, and sitting down returns bets on the live hand', async () => {
  const s = await setup();
  const other = await s.app.game.createTable({ name: 'T2' }, s.admin);
  const alex = await s.player('alex');
  const t = await s.app.tournaments.create({ name: 'Race', startsAt: s.clock.t, endsAt: s.clock.t + 3600_000 }, s.admin);
  await s.app.tournaments.join(t.id, alex);

  const r1 = await s.app.game.openRound(s.table.id, 'staff:dealer');
  const r2 = await s.app.game.openRound(other.id, 'staff:dealer');
  await s.app.game.placeBet(alex, { roundId: r1.id, marketId: 'HAS_ACE', stake: 1000 });
  await s.app.tournaments.placeBet(t.id, alex, { roundId: r1.id, marketId: 'HAS_ACE', stake: 100 });

  const seat = await s.app.game.seatPlayer(s.table.id, alex.id, 'staff:dealer');
  assert.equal(seat.betsCancelled, 2);
  assert.equal(await s.balance(alex.id), 100_000);
  assert.equal((await s.app.tournaments.entry(t.id, alex.id))!.points, 1000);
  assert.equal((await s.app.tournaments.entry(t.id, alex.id))!.bets_used, 0);
  assert.equal((await s.app.game.roundRisk(r1.id)).EUR.stakes, 0);

  await err(s.app.game.placeBet(alex, { roundId: r1.id, marketId: 'HAS_ACE', stake: 1000 }), 'SEATED_AT_TABLE');
  await err(() => s.app.tournaments.placeBet(t.id, alex, { roundId: r1.id, marketId: 'HAS_ACE', stake: 100 }), 'SEATED_AT_TABLE');
  // Other tables are fine.
  await s.app.game.placeBet(alex, { roundId: r2.id, marketId: 'HAS_ACE', stake: 1000 });
  assert.deepEqual((await s.app.game.seats(s.table.id)).map((x: any) => x.playerId), [alex.id]);

  // Moving to the other table frees the first one.
  await s.app.game.seatPlayer(other.id, alex.id, 'staff:dealer');
  assert.equal((await s.app.game.seats(s.table.id)).length, 0);
  assert.equal((await s.app.game.playerBets(alex.id)).find((b) => b.roundId === r2.id)!.status, 'refunded');
  await s.app.game.placeBet(alex, { roundId: r1.id, marketId: 'HAS_ACE', stake: 1000 });
  await s.app.game.unseatPlayer(other.id, alex.id, 'staff:dealer');
  assert.equal(await s.app.game.seatOf(alex.id), null);
  assert.equal((await s.app.ledger.verify()).ok, true);
});
