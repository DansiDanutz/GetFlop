import { test } from 'node:test';
import assert from 'node:assert/strict';
import { http, setup } from './helpers.ts';

test('my account: profile, balance, betting record and a statement that adds up', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const reg = await http(s.app, 'POST', '/v1/auth/register', { username: 'lena', password: 'long-password', displayName: 'Lena' });
  const auth = { authorization: `Bearer ${reg.body.token}` };
  const id = reg.body.player.id;
  await s.app.accounts.cashier(id, 10_000, 'desk', s.admin);
  const p = (await s.app.db.get('SELECT * FROM players WHERE id = ?', id)) as any;

  // One win, one loss, one bet returned by a void, one tournament buy-in.
  const r1 = await s.app.game.openRound(s.table.id, 'd');
  await s.app.game.placeBet(p, { roundId: r1.id, marketId: 'HAS_FACE', stake: 1000 }); // wins 1710
  await s.app.game.placeBet(p, { roundId: r1.id, marketId: 'PAIRED', stake: 500 }); // loses
  await s.app.game.closeRound(r1.id, 'd');
  await s.app.game.submitFlop(r1.id, ['Qh', '4h', '9d'], 'd');
  const r2 = await s.app.game.openRound(s.table.id, 'd');
  await s.app.game.placeBet(p, { roundId: r2.id, marketId: 'RAINBOW', stake: 300 });
  await s.app.game.voidRound(r2.id, 'misdeal', 'f');
  const tour = await s.app.tournaments.create({ name: 'Evening race', buyIn: 200, startsAt: s.clock.t, endsAt: s.clock.t + 3600_000 }, s.admin);
  await s.app.tournaments.join(tour.id, p);

  const acc = (await http(s.app, 'GET', '/v1/me/account', undefined, auth)).body;
  assert.deepEqual([acc.profile.displayName, acc.profile.username, acc.profile.accountType], ['Lena', 'lena', 'direct']);
  assert.equal(acc.balance, 10_000 - 1000 - 500 + 1710 - 200);
  assert.deepEqual(acc.stats, { bets: 2, staked: 1500, won: 1, settled: 2, net: 1710 - 1500, biggestWin: 710, inPlay: 0 });
  assert.equal(acc.tournaments[0].name, 'Evening race');
  assert.ok(acc.limits);

  // Newest first; each line's balance follows from the one before it.
  const lines = acc.statement;
  assert.equal(lines[0].balanceAfter, acc.balance);
  for (let i = 1; i < lines.length; i++) assert.equal(lines[i - 1].balanceAfter - lines[i - 1].amount, lines[i].balanceAfter);
  assert.equal(lines.at(-1).text, 'Deposit at the desk');
  assert.equal(lines.at(-1).balanceAfter, 10_000);
  const texts = lines.map((l: any) => l.text);
  assert.ok(texts.includes('Win · At least one J, Q or K · T1 #1'));
  assert.ok(texts.includes('Bet returned · Rainbow (3 different suits) · T1 #2'));
  assert.ok(texts.includes('Tournament buy-in · Evening race'));
});

test('players can rename themselves and change their password; other sessions end', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const reg = await http(s.app, 'POST', '/v1/auth/register', { username: 'omar', password: 'first-password' });
  const other = await http(s.app, 'POST', '/v1/auth/login', { username: 'omar', password: 'first-password' });
  const auth = { authorization: `Bearer ${reg.body.token}` };

  assert.equal((await http(s.app, 'POST', '/v1/me/profile', { displayName: 'Omar the Great' }, auth)).body.displayName, 'Omar the Great');
  assert.equal((await http(s.app, 'GET', '/v1/me', undefined, auth)).body.displayName, 'Omar the Great');

  assert.equal((await http(s.app, 'POST', '/v1/me/password', { currentPassword: 'nope-nope', newPassword: 'second-password' }, auth)).body.error, 'BAD_CREDENTIALS');
  assert.equal((await http(s.app, 'POST', '/v1/me/password', { currentPassword: 'first-password', newPassword: 'second-password' }, auth)).status, 200);
  assert.equal((await http(s.app, 'GET', '/v1/me', undefined, auth)).status, 200); // this session stays
  assert.equal((await http(s.app, 'GET', '/v1/me', undefined, { authorization: `Bearer ${other.body.token}` })).status, 401);
  assert.equal((await http(s.app, 'POST', '/v1/auth/login', { username: 'omar', password: 'first-password' })).body.error, 'BAD_CREDENTIALS');
  assert.equal((await http(s.app, 'POST', '/v1/auth/login', { username: 'omar', password: 'second-password' })).status, 200);
});

test('the lobby lists every active table live: odds, the hand in play and the last flops', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.app.game.createTable({ name: 'T2', marginBps: 300 }, s.admin);
  const r = await s.app.game.openRound(s.table.id, 'd');
  await s.app.game.closeRound(r.id, 'd');
  await s.app.game.submitFlop(r.id, ['Ah', 'Kd', '2c'], 'd');
  await s.app.game.openRound(s.table.id, 'd');

  const lobby = (await http(s.app, 'GET', '/v1/tables')).body;
  assert.deepEqual(lobby.map((x: any) => x.name), ['T1', 'T2']);
  const t1 = lobby[0];
  assert.equal(t1.round.status, 'open');
  assert.equal(t1.round.number, 2);
  assert.deepEqual(t1.recent, [{ number: 1, flop: ['Ah', 'Kd', '2c'] }]);
  assert.equal(t1.markets.find((m: any) => m.id === 'RAINBOW').oddsX100, 238);
  // Odds follow each table's own margin.
  assert.ok(lobby[1].markets.find((m: any) => m.id === 'RAINBOW').oddsX100 > 238);
});
