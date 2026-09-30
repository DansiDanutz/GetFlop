import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';
import { pointsRace } from '../src/tournaments.ts';

const HOUR = 3600_000;

test('points race: bet limit, leaderboard, top % paid, rake', async () => {
  const s = setup();
  const t = s.app.tournaments.create({
    name: 'Evening race', strategy: 'points_race', currency: 'EUR', buyIn: 1000, rakeBps: 1000,
    startsAt: s.clock.t, endsAt: s.clock.t + 8 * HOUR, rules: { startingPoints: 1000, maxBets: 3, minStake: 10, paidPercent: 10 },
  }, s.admin);
  assert.equal(t.status, 'running');

  const players = Array.from({ length: 20 }, (_, i) => s.player(`p${i}`, 5000));
  for (const p of players) s.app.tournaments.join(t.id, p);
  assert.throws(() => s.app.tournaments.join(t.id, players[0]), { code: 'ALREADY_JOINED' });
  assert.equal(s.balance(players[0].id), 4000);

  const round = s.app.game.openRound(s.table.id, 'staff:dealer');
  const bet = (i: number, marketId: string, stake: number) => s.app.tournaments.placeBet(t.id, players[i], { roundId: round.id, marketId, stake });
  bet(0, 'TRIPS', 100); // wins big
  bet(1, 'ALL_LOW', 500); // wins
  bet(2, 'MONOTONE', 1000); // loses
  for (let i = 3; i < 20; i++) bet(i, 'MONOTONE', 10); // lose
  bet(0, 'NO_PAIR', 10);
  bet(0, 'NO_PAIR', 10);
  assert.throws(() => bet(0, 'NO_PAIR', 10), { code: 'NO_BETS_LEFT' });
  assert.throws(() => bet(3, 'RAINBOW', 5000), { code: 'STAKE_OUT_OF_RANGE' });

  s.app.game.closeRound(round.id, 'staff:dealer');
  s.app.game.submitFlop(round.id, ['7h', '7d', '7c'], 'staff:dealer');

  const board = s.app.tournaments.leaderboard(t.id);
  assert.equal(board[0].playerId, players[0].id);
  assert.equal(board[0].points, 1000 - 120 + 40375);
  assert.equal(board[1].playerId, players[1].id);
  assert.equal(board[1].points, 1000 - 500 + 2115);
  assert.equal(board.at(-1)!.playerId, players[2].id);

  // Finishes only after the end time.
  s.app.tournaments.tick();
  assert.equal(s.app.tournaments.get(t.id).status, 'running');
  s.advance(8 * HOUR);
  s.app.tournaments.tick(); // -> finishing
  s.app.tournaments.tick(); // -> finished (no open bets)
  const done = s.app.tournaments.view(t.id);
  assert.equal(done.status, 'finished');
  assert.equal(done.prizePool, 18_000); // 20 x 1000 minus 10% fee
  // Top 10% of 20 = 2 paid, top-heavy split 1 : 1/2.
  assert.deepEqual(done.leaderboard.slice(0, 3).map((r: any) => r.prize), [12_000, 6_000, 0]);
  assert.equal(s.balance(players[0].id), 4000 + 12_000);
  assert.equal(s.app.ledger.balance('house:rake', 'EUR'), 2000);
  assert.equal(s.app.ledger.balance(`tournament:${t.id}`, 'EUR'), 0);
  assert.equal(s.app.ledger.verify().ok, true);
});

test('guaranteed freeroll: the house covers the pool, and bets on a voided round come back', () => {
  const s = setup();
  const t = s.app.tournaments.create({ name: 'Free', buyIn: 0, guaranteed: 10_000, startsAt: s.clock.t, endsAt: s.clock.t + HOUR, rules: { paidPercent: 5 } }, s.admin);
  const a = s.player('a', 0);
  const b = s.player('b', 0);
  s.app.tournaments.join(t.id, a);
  s.app.tournaments.join(t.id, b);

  const r1 = s.app.game.openRound(s.table.id, 'd');
  s.app.tournaments.placeBet(t.id, a, { roundId: r1.id, marketId: 'RAINBOW', stake: 500 });
  s.app.game.voidRound(r1.id, 'misdeal', 'f');
  assert.equal(s.app.tournaments.entry(t.id, a.id)!.points, 1000);
  assert.equal(s.app.tournaments.entry(t.id, a.id)!.bets_used, 0);

  const r2 = s.app.game.openRound(s.table.id, 'd');
  s.app.tournaments.placeBet(t.id, a, { roundId: r2.id, marketId: 'HAS_ACE', stake: 100 });
  s.app.tournaments.placeBet(t.id, b, { roundId: r2.id, marketId: 'HAS_ACE', stake: 50 });
  s.advance(HOUR); // tournament ends while r2 is still being dealt
  s.app.tournaments.tick();
  s.app.tournaments.tick();
  assert.equal(s.app.tournaments.get(t.id).status, 'finishing');
  assert.throws(() => s.app.tournaments.placeBet(t.id, a, { roundId: r2.id, marketId: 'HAS_ACE', stake: 10 }), { code: 'TOURNAMENT_NOT_RUNNING' });

  s.app.game.closeRound(r2.id, 'd');
  s.app.game.submitFlop(r2.id, ['Ah', 'Kd', '2c'], 'd');
  s.app.tournaments.tick();
  const done = s.app.tournaments.view(t.id);
  assert.equal(done.status, 'finished');
  assert.equal(done.leaderboard[0].playerId, a.id);
  assert.equal(s.balance(a.id), 10_000); // 5% of 2 entrants -> 1 paid place
  assert.equal(s.balance(b.id), 0);
  assert.equal(s.app.ledger.balance('house:overlay', 'EUR'), -10_000);
});

test('cancelling refunds buy-ins; nobody qualifying refunds too', () => {
  const s = setup();
  const t = s.app.tournaments.create({ name: 'C', buyIn: 500, startsAt: s.clock.t + HOUR, endsAt: s.clock.t + 2 * HOUR }, s.admin);
  const a = s.player('a', 1000);
  s.app.tournaments.join(t.id, a);
  assert.equal(s.balance(a.id), 500);
  s.app.tournaments.cancel(t.id, 'not enough players', s.admin);
  assert.equal(s.balance(a.id), 1000);

  const t2 = s.app.tournaments.create({ name: 'D', buyIn: 500, startsAt: s.clock.t, endsAt: s.clock.t + HOUR, rules: { minBetsToQualify: 1 } }, s.admin);
  s.app.tournaments.join(t2.id, a);
  s.advance(HOUR);
  s.app.tournaments.tick();
  s.app.tournaments.tick();
  assert.equal(s.app.tournaments.get(t2.id).status, 'finished');
  assert.equal(s.balance(a.id), 1000);
});

test('prize split always adds up to the pool', () => {
  const rules = pointsRace.parseRules({});
  for (const n of [1, 2, 3, 7, 50]) {
    for (const pool of [1, 99, 10_000, 123_457]) {
      const split = pointsRace.prizeSplit(rules, n, pool);
      assert.equal(split.reduce((a, b) => a + b, 0), pool);
      for (let i = 1; i < split.length; i++) assert.ok(split[i] <= split[i - 1]);
    }
  }
  assert.throws(() => pointsRace.parseRules({ minStake: 50, maxStake: 10 }), { code: 'BAD_INPUT' });
});
