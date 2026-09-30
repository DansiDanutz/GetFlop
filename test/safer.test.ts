import { test } from 'node:test';
import assert from 'node:assert/strict';
import { http, setup } from './helpers.ts';
import type { PlayerRow } from '../src/game.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function directPlayer(s: Awaited<ReturnType<typeof setup>>, name: string, deposit: number) {
  const res = await s.app.accounts.registerPlayer({ username: name, password: 'long-password' });
  const p = (await s.app.db.get<PlayerRow>('SELECT * FROM players WHERE id = ?', res.player.id))!;
  if (deposit) await s.app.accounts.cashier(p.id, deposit, 'desk', s.admin);
  return { p, token: res.token };
}

// Plays one losing round (rainbow bet, monotone flop) or a winning one.
async function round(s: Awaited<ReturnType<typeof setup>>, p: PlayerRow, stake: number, win = false) {
  const r = await s.app.game.openRound(s.table.id, 'd');
  await s.app.game.placeBet(p, { roundId: r.id, marketId: 'RAINBOW', stake });
  await s.app.game.closeRound(r.id, 'd');
  await s.app.game.submitFlop(r.id, win ? ['Ah', 'Kd', '2c'] : ['Ah', 'Kh', '2h'], 'd');
}

test('loss limits count net losses in a rolling window and stop the next bet', async () => {
  const s = await setup();
  const { p } = await directPlayer(s, 'lena', 100_000);
  await s.app.safer.setLimits(p, { lossDay: 5000 });

  await round(s, p, 3000); // -3000
  await round(s, p, 1000, true); // +2380 back, net loss 1620 (stake 1000 + 3000 - 2380)
  assert.equal((await s.app.safer.view(p)).used.lossDay, 1620);
  await round(s, p, 3000); // loss 4620
  // An open bet counts as lost until it settles: 4620 + 500 > 5000.
  const r = await s.app.game.openRound(s.table.id, 'd');
  await assert.rejects(s.app.game.placeBet(p, { roundId: r.id, marketId: 'RAINBOW', stake: 500 }), { code: 'LOSS_LIMIT' });
  await s.app.game.placeBet(p, { roundId: r.id, marketId: 'RAINBOW', stake: 300 });
  await s.app.game.voidRound(r.id, 'misdeal', 'f'); // refunded stakes are not losses
  assert.equal((await s.app.safer.view(p)).used.lossDay, 4620);

  // A day later the window has moved on.
  s.advance(DAY + 1);
  const r2 = await s.app.game.openRound(s.table.id, 'd');
  await s.app.game.placeBet(p, { roundId: r2.id, marketId: 'RAINBOW', stake: 4000 });
});

test('tightening applies at once; raising or removing waits 24 hours', async () => {
  const s = await setup();
  const { p } = await directPlayer(s, 'omar', 0);
  let v = await s.app.safer.setLimits(p, { lossDay: 10_000, lossWeek: 50_000 });
  assert.deepEqual([v.lossDay, v.lossWeek, v.pending], [10_000, 50_000, null]);

  v = await s.app.safer.setLimits(p, { lossDay: 20_000, lossWeek: 40_000 });
  assert.equal(v.lossDay, 10_000); // raise waits
  assert.equal(v.lossWeek, 40_000); // lower applies
  assert.deepEqual(v.pending, { lossDay: 20_000 });
  assert.equal(v.pendingFrom, s.clock.t + DAY);

  s.advance(12 * HOUR);
  v = await s.app.safer.setLimits(p, { lossWeek: null }); // removing is a raise: restarts the wait
  assert.deepEqual(v.pending, { lossDay: 20_000, lossWeek: null });
  assert.equal(v.pendingFrom, s.clock.t + DAY);

  s.advance(DAY);
  v = await s.app.safer.view(p);
  assert.deepEqual([v.lossDay, v.lossWeek, v.pending], [20_000, null, null]);

  // Changing your mind before the wait ends: asking for the current value cancels the raise.
  await s.app.safer.setLimits(p, { lossDay: 30_000 });
  v = await s.app.safer.setLimits(p, { lossDay: 20_000 });
  assert.equal(v.pending, null);
});

test('a break stops betting, tournaments and deposits, and cannot be shortened', async () => {
  const s = await setup();
  const { p } = await directPlayer(s, 'kai', 10_000);
  const t = await s.app.tournaments.create({ name: 'Free', startsAt: s.clock.t, endsAt: s.clock.t + DAY }, s.admin);
  await s.app.tournaments.join(t.id, p);

  let v = await s.app.safer.takeBreak(p, 7);
  assert.equal(v.excludedUntil, s.clock.t + 7 * DAY);
  v = await s.app.safer.takeBreak(p, 1); // shorter: the longer break stays
  assert.equal(v.excludedUntil, s.clock.t + 7 * DAY);
  await assert.rejects(s.app.safer.takeBreak(p, 3), { code: 'BAD_INPUT' });

  const r = await s.app.game.openRound(s.table.id, 'd');
  await assert.rejects(s.app.game.placeBet(p, { roundId: r.id, marketId: 'RAINBOW', stake: 100 }), { code: 'ON_BREAK' });
  await assert.rejects(s.app.tournaments.placeBet(t.id, p, { roundId: r.id, marketId: 'RAINBOW', stake: 10 }), { code: 'ON_BREAK' });
  const t2 = await s.app.tournaments.create({ name: 'Free 2', startsAt: s.clock.t, endsAt: s.clock.t + DAY }, s.admin);
  await assert.rejects(s.app.tournaments.join(t2.id, p), { code: 'ON_BREAK' });
  await assert.rejects(s.app.accounts.cashier(p.id, 5000, 'desk', s.admin), { code: 'ON_BREAK' });
  // Taking money out is always allowed.
  assert.equal((await s.app.accounts.cashier(p.id, -4000, 'desk', s.admin)).balance, 6000);

  await s.app.game.voidRound(r.id, 'test', 'f');
  s.advance(7 * DAY);
  const r2 = await s.app.game.openRound(s.table.id, 'd');
  await s.app.game.placeBet(p, { roundId: r2.id, marketId: 'RAINBOW', stake: 100 });
});

test('deposit limit at the cashier, buy-ins count as losses, partner players are out of scope', async () => {
  const s = await setup();
  const { p } = await directPlayer(s, 'ines', 0);
  await s.app.safer.setLimits(p, { depositWeek: 20_000, lossDay: 3000 });
  await s.app.accounts.cashier(p.id, 15_000, 'desk', s.admin);
  await assert.rejects(s.app.accounts.cashier(p.id, 6000, 'desk', s.admin), { code: 'DEPOSIT_LIMIT' });
  await s.app.accounts.cashier(p.id, 5000, 'desk', s.admin);

  const paid = await s.app.tournaments.create({ name: 'Paid', buyIn: 2000, startsAt: s.clock.t, endsAt: s.clock.t + DAY }, s.admin);
  const paid2 = await s.app.tournaments.create({ name: 'Paid 2', buyIn: 2000, startsAt: s.clock.t, endsAt: s.clock.t + DAY }, s.admin);
  await s.app.tournaments.join(paid.id, p);
  await assert.rejects(s.app.tournaments.join(paid2.id, p), { code: 'LOSS_LIMIT' });

  const partnerPlayer = await s.player('partner-1');
  await assert.rejects(s.app.safer.view(partnerPlayer), { code: 'NOT_DIRECT_PLAYER' });
});

test('safer play over HTTP, and staff can see a player\'s settings', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const { p, token } = await directPlayer(s, 'zoe', 0);
  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await http(s.app, 'GET', '/v1/me', undefined, auth)).body.direct, true);
  const set = await http(s.app, 'POST', '/v1/me/limits', { lossWeek: 25_000 }, auth);
  assert.equal(set.body.lossWeek, 25_000);
  const brk = await http(s.app, 'POST', '/v1/me/break', { days: 30 }, auth);
  assert.equal(brk.body.excludedUntil, s.clock.t + 30 * DAY);

  await s.app.accounts.createStaff('floor', 'floor-password-1', 'supervisor', 'system');
  const floor = { authorization: `Bearer ${(await http(s.app, 'POST', '/v1/staff/login', { username: 'floor', password: 'floor-password-1' })).body.token}` };
  const seen = await http(s.app, 'GET', `/v1/admin/players/${p.id}/limits`, undefined, floor);
  assert.equal(seen.body.excludedUntil, s.clock.t + 30 * DAY);
  const audit = await s.app.audit.list(10, 'player.time_out');
  assert.equal(audit.length, 1);
});
