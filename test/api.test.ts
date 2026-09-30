import { test } from 'node:test';
import assert from 'node:assert/strict';
import { http, setup, signed } from './helpers.ts';

test('operator API: signed requests, launch sessions, transfers and reconciliation', async (t) => {
  const s = await setup({ publicUrl: 'https://play.getflop.test' });
  t.after(() => s.app.stop());
  const call = (method: string, path: string, body?: unknown) => http(s.app, method, path, body, signed(s.op, s.clock.t, method, path, body));

  const unsigned = await http(s.app, 'POST', '/v1/operator/sessions', { playerId: 'u1' });
  assert.equal(unsigned.body.error, 'UNSIGNED');
  const forged = await http(s.app, 'POST', '/v1/operator/sessions', { playerId: 'u1' }, { ...signed(s.op, s.clock.t, 'POST', '/v1/operator/sessions', { playerId: 'u2' }) });
  assert.equal(forged.body.error, 'BAD_SIGNATURE');
  const stale = await http(s.app, 'POST', '/v1/operator/sessions', { playerId: 'u1' }, signed(s.op, s.clock.t - 10 * 60_000, 'POST', '/v1/operator/sessions', { playerId: 'u1' }));
  assert.equal(stale.body.error, 'STALE_TIMESTAMP');

  const session = await call('POST', '/v1/operator/sessions', { playerId: 'u1', displayName: 'Uma' });
  assert.equal(session.status, 200);
  assert.match(session.body.launchUrl, /^https:\/\/play\.getflop\.test\/play\.html#token=/);

  const dep = await call('POST', '/v1/operator/players/deposit', { playerId: 'u1', amount: 5000, txId: 'd1' });
  const again = await call('POST', '/v1/operator/players/deposit', { playerId: 'u1', amount: 5000, txId: 'd1' });
  assert.equal(dep.body.balance, 5000);
  assert.equal(again.body.balance, 5000); // same txId: applied once

  const auth = { authorization: `Bearer ${session.body.token}` };
  const round = await s.app.game.openRound(s.table.id, 'staff:dealer');
  const bet = await http(s.app, 'POST', '/v1/bets', { roundId: round.id, marketId: 'ALL_RED', stake: 1000 }, auth);
  assert.equal(bet.status, 200, JSON.stringify(bet.body));
  assert.equal((await http(s.app, 'GET', '/v1/me', undefined, auth)).body.balance, 4000);

  const view = await http(s.app, 'GET', `/v1/tables/${s.table.id}`);
  assert.equal(view.body.round.betsByMarket.ALL_RED, 1);

  const bets = await call('GET', '/v1/operator/bets?from=0');
  assert.equal(bets.body.bets.length, 1);
  assert.equal(bets.body.bets[0].playerId, 'u1');
  assert.equal(bets.body.nextCursor, null);

  const withdraw = await call('POST', '/v1/operator/players/withdraw', { playerId: 'u1', amount: 9000, txId: 'w1' });
  assert.equal(withdraw.body.error, 'INSUFFICIENT_FUNDS');
});

test('direct sign-up, staff roles and the dealer flow over HTTP', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.app.accounts.createStaff('boss', 'boss-password-1', 'admin', 'system');
  await s.app.accounts.createStaff('deal', 'deal-password-1', 'dealer', 'system');

  const reg = await http(s.app, 'POST', '/v1/auth/register', { username: 'Nick', password: 'secret-pass', displayName: 'Nick' });
  assert.equal(reg.status, 200);
  assert.equal((await http(s.app, 'POST', '/v1/auth/register', { username: 'nick', password: 'secret-pass' })).body.error, 'USERNAME_TAKEN');
  assert.equal((await http(s.app, 'POST', '/v1/auth/login', { username: 'nick', password: 'wrong-pass' })).body.error, 'BAD_CREDENTIALS');
  const login = await http(s.app, 'POST', '/v1/auth/login', { username: 'nick', password: 'secret-pass' });
  const player = { authorization: `Bearer ${login.body.token}` };

  const boss = { authorization: `Bearer ${(await http(s.app, 'POST', '/v1/staff/login', { username: 'boss', password: 'boss-password-1' })).body.token}` };
  const deal = { authorization: `Bearer ${(await http(s.app, 'POST', '/v1/staff/login', { username: 'deal', password: 'deal-password-1' })).body.token}` };
  assert.equal((await http(s.app, 'GET', '/v1/admin/operators', undefined, deal)).status, 403);

  const cash = await http(s.app, 'POST', `/v1/admin/players/${reg.body.player.id}/cashier`, { amount: 2000, note: 'cash at the desk' }, boss);
  assert.equal(cash.body.balance, 2000);

  const round = (await http(s.app, 'POST', `/v1/dealer/tables/${s.table.id}/rounds`, {}, deal)).body;
  await http(s.app, 'POST', '/v1/bets', { roundId: round.id, marketId: 'HAS_FACE', stake: 1000 }, player);
  assert.equal((await http(s.app, 'POST', `/v1/dealer/rounds/${round.id}/void`, { reason: 'x' }, deal)).status, 403); // supervisor+
  await http(s.app, 'POST', `/v1/dealer/rounds/${round.id}/close`, {}, deal);
  const flop = await http(s.app, 'POST', `/v1/dealer/rounds/${round.id}/flop`, { cards: ['Qs', '4h', '9d'] }, deal);
  assert.equal(flop.body.settled, true);
  assert.equal((await http(s.app, 'GET', '/v1/me', undefined, player)).body.balance, 1000 + 1710);

  const report = await http(s.app, 'GET', '/v1/admin/reports/ggr?from=0', undefined, boss);
  assert.equal(report.body.rows[0].ggr, 1000 - 1710);
  const integrity = await http(s.app, 'GET', '/v1/admin/integrity', undefined, boss);
  assert.equal(integrity.body.ledger.ok, true);
  assert.equal(integrity.body.audit.ok, true);
});

test('commission invoices carry losing periods forward', async () => {
  const s = await setup();
  const DAY = 86_400_000;
  const p = await s.player('whale', 1_000_000);
  const play = async (market: string, stake: number, flop: string[]) => {
    const r = await s.app.game.openRound(s.table.id, 'd');
    await s.app.game.placeBet(p, { roundId: r.id, marketId: market, stake });
    await s.app.game.closeRound(r.id, 'd');
    await s.app.game.submitFlop(r.id, flop, 'd');
  };
  const start = s.clock.t;
  await play('TRIPS', 1000, ['9h', '9d', '9c']); // house loses 403,750 - 1,000
  s.advance(DAY);
  const inv1 = await s.app.billing.createInvoice(s.op.id, start, s.clock.t, s.admin);
  assert.equal(inv1.commission, 0);
  assert.equal(inv1.carry_out, -402_750);

  for (let i = 0; i < 5; i++) await play('RAINBOW', 100_000, ['Ah', 'Kh', '2c']); // player loses 500,000
  s.advance(DAY);
  await assert.rejects(async () => s.app.billing.createInvoice(s.op.id, start, s.clock.t, s.admin), { code: 'PERIOD_NOT_CONTIGUOUS' });
  const inv2 = await s.app.billing.createInvoice(s.op.id, inv1.period_to, s.clock.t, s.admin);
  assert.equal(inv2.ggr, 500_000);
  assert.equal(inv2.commission_base, 500_000 - 402_750);
  assert.equal(inv2.commission, Math.floor(97_250 * 0.2));
  assert.equal(inv2.carry_out, 0);
});

test('demo mode: instant play-money players, demo logins, and clocks that advance on requests', async (t) => {
  const s = await setup({ demo: true, tickOnRequest: true });
  t.after(() => s.app.stop());
  assert.equal((await http(s.app, 'GET', '/v1/demo/info')).body.demo, true);
  const guest = await http(s.app, 'POST', '/v1/demo/player');
  assert.equal(guest.status, 200);
  const me = await http(s.app, 'GET', '/v1/me', undefined, { authorization: `Bearer ${guest.body.token}` });
  assert.equal(me.body.balance, 50_000);
  // No background timer: the round closes on the next request after its window.
  const round = await s.app.game.openRound(s.table.id, 'staff:dealer');
  s.advance(31_000);
  await http(s.app, 'GET', '/v1/health');
  assert.equal((await s.app.game.round(round.id)).status, 'closed');
});

test('demo endpoints are off outside demo mode', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  assert.equal((await http(s.app, 'GET', '/v1/demo/info')).body.demo, false);
  assert.equal((await http(s.app, 'POST', '/v1/demo/player')).status, 404);
});
